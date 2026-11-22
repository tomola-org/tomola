import { noticesAvailable } from "~/lib/notices.server";
import { createHash } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { passkeyRecoveryPermits, profiles, user } from "~/lib/db/schema";
import { getMailer, type Mailer } from "~/lib/mail/mail.server";
import { memberMailLocale } from "~/lib/mail/magic-link.server";
import { siteUrl } from "~/lib/site-url";
import { recoveryToken } from "~/lib/auth/passkey-recovery-token.server";
import { m } from "~/paraglide/messages.js";
import { defineJobHandlers } from "./queue.server";
import { SEND_PASSKEY_NOTICE_JOB } from "./mail-kinds";

export function createPasskeyHandlers(mailer: () => Mailer = getMailer) {
  return defineJobHandlers({ [SEND_PASSKEY_NOTICE_JOB]: async (job, { db }) => {
    const data = job.payload;
    const [account] = await db.select({ email: user.email, locale: profiles.uiLocale, homeArea: profiles.homeArea }).from(user).leftJoin(profiles, eq(profiles.userId, user.id)).where(eq(user.id, data.userId));
    if (!account) return;
    const locale = { locale: memberMailLocale(account.locale, account.homeArea) };
    let url = new URL("/settings", siteUrl());
    if (data.action === "recovery") {
      if (!data.recoveryId) return;
      const token = recoveryToken(data.userId, data.recoveryId);
      const [permit] = await db.select({ tokenHash: passkeyRecoveryPermits.tokenHash }).from(passkeyRecoveryPermits)
        .where(and(eq(passkeyRecoveryPermits.userId, data.userId), eq(passkeyRecoveryPermits.recoveryId, data.recoveryId), gt(passkeyRecoveryPermits.expiresAt, new Date())));
      if (!permit) return;
      if (permit.tokenHash !== createHash("sha256").update(token).digest("hex")) {
        console.warn("[passkey-recovery] active permit hash does not match the delivery job");
        return;
      }
      url = new URL("/auth/recover-passkeys", siteUrl());
      url.hash = token;
    }
    const texts = {
      added: m.passkey_notice_added, removed: m.passkey_notice_removed, recovery: m.passkey_notice_recovery,
      google_connected: m.login_methods_notice_google_connected, google_disconnected: m.login_methods_notice_google_disconnected,
      passkey_only_enabled: m.login_methods_notice_enabled, passkey_only_disabled: m.login_methods_notice_disabled,
    };
    const text = texts[data.action]({ name: data.name, at: data.at }, locale);
    await mailer().send({ to: account.email, locale: locale.locale, subject: m.passkey_notice_subject({}, locale), text: `${text}\n\n${url.href}${noticesAvailable().privacy ? `\n\n${new URL("/privacy#s6", siteUrl()).href}` : ""}` });
  } });
}
