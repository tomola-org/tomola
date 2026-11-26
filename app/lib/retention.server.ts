import { eq, and, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { aiQuestionReports, nushiReports, chatAccessLog, chatNushiReservations, llmUsage, notifications, nushiReservations, pushDeliveries, pushSubscriptions, session, signingChallenges, suspendedEmailHashes, oauthAccessToken, oauthClientAssertion, oauthRefreshToken } from "~/lib/db/schema";
import { RETENTION, daysBefore, monthsBefore } from "~/lib/retention";
import { drainRetentionRows, withRetentionRun, type RetentionResults, type RetentionRunOptions } from "~/lib/retention-batch.server";
import { cleanupExpiredLimits } from "~/lib/rate-limit.server";
import { dayOf } from "~/lib/nushi-requests.server";
import { pushStoppedValues } from "~/lib/push/subscriptions.server";

export function runRetentionCleanup(db: Db, now = new Date(), options: RetentionRunOptions = {}): Promise<RetentionResults> {
  return withRetentionRun(options, async () => {
    const results = await cleanupExpiredLimits(db, now);
    const reservationCutoff = dayOf(daysBefore(now, 1));
    await drainRetentionRows(db, "nushi_reservations", nushiReservations, lt(nushiReservations.day, reservationCutoff), results);
    await drainRetentionRows(db, "chat_nushi_reservations", chatNushiReservations, lt(chatNushiReservations.day, reservationCutoff), results);
    await drainRetentionRows(db, "nushi_error_reports", nushiReports, and(eq(nushiReports.kind, "error"), lt(nushiReports.createdAt, daysBefore(now, RETENTION.aiQuestionReportDays)))!, results);
    await drainRetentionRows(db, "nushi_moderation_reports", nushiReports, and(eq(nushiReports.kind, "moderation"), lt(nushiReports.createdAt, daysBefore(now, RETENTION.villageReportDays)))!, results);
    await drainRetentionRows(db, "ai_question_reports", aiQuestionReports, lt(aiQuestionReports.createdAt, daysBefore(now, RETENTION.aiQuestionReportDays)), results);
    await drainRetentionRows(db, "suspended_email_hashes", suspendedEmailHashes, lte(suspendedEmailHashes.expiresAt, now), results);
    await drainRetentionRows(db, "sessions", session, or(lte(session.expiresAt, now), lte(session.createdAt, daysBefore(now, RETENTION.sessionAbsoluteDays)))!, results);
    await drainRetentionRows(db, "chat_access_log", chatAccessLog, lt(chatAccessLog.createdAt, monthsBefore(now, RETENTION.chatAccessYears * 12)), results);
    await drainRetentionRows(db, "notifications", notifications, or(
      and(isNotNull(notifications.readAt), lt(notifications.readAt, daysBefore(now, RETENTION.readNotificationDays))),
      and(isNull(notifications.readAt), lt(notifications.createdAt, daysBefore(now, RETENTION.unreadNotificationDays))),
    )!, results);
    await drainRetentionRows(db, "push_deliveries", pushDeliveries, and(isNotNull(pushDeliveries.completedAt), lt(pushDeliveries.completedAt, daysBefore(now, RETENTION.finishedPushDays)))!, results);
    const stopped = pushStoppedValues("expired");
    await drainRetentionRows(db, "push_subscriptions", pushSubscriptions, and(
      isNull(pushSubscriptions.stoppedReason),
      lt(pushSubscriptions.authorizedUntil, daysBefore(now, RETENTION.expiredPushAuthorizationDays)),
    )!, results, sql`stopped_reason = ${stopped.stoppedReason}, generation = ${stopped.generation},
      endpoint = ${stopped.endpoint}, p256dh = ${stopped.p256dh}, auth = ${stopped.auth}`);
    // The ledger contains no member identifier or request text; no link to anonymize.
    await drainRetentionRows(db, "llm_usage", llmUsage, lt(llmUsage.createdAt, monthsBefore(now, RETENTION.llmUsageMonths)), results);
    // Historical posting challenges can contain copies of post text.
    await drainRetentionRows(db, "signing_challenges", signingChallenges, lte(signingChallenges.expiresAt, now), results);
    const oauthCutoff = daysBefore(now, RETENTION.oauthExpiryGraceDays);
    await drainRetentionRows(db, "oauth_access_tokens", oauthAccessToken, lt(oauthAccessToken.expiresAt, oauthCutoff), results);
    await drainRetentionRows(db, "oauth_client_assertions", oauthClientAssertion, lt(oauthClientAssertion.expiresAt, oauthCutoff), results);
    // Keep refresh tokens through expiry and any replay window. Leave linked
    // access tokens to their own bounded drain so the foreign key cannot cascade.
    await drainRetentionRows(db, "oauth_refresh_tokens", oauthRefreshToken, and(
      lt(oauthRefreshToken.expiresAt, oauthCutoff),
      or(isNull(oauthRefreshToken.rotationReplayExpiresAt), lt(oauthRefreshToken.rotationReplayExpiresAt, oauthCutoff)),
      sql`not exists (select 1 from ${oauthAccessToken} where ${oauthAccessToken.refreshId} = ${oauthRefreshToken.id})`,
    )!, results);
    return results;
  });
}
