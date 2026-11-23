import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { pushSubscriptions } from "~/lib/db/schema";
import { getAuth } from "~/lib/auth/auth.server";
import { createReply, createTopic } from "~/lib/entries.server";
import { createPushHandlers } from "~/lib/jobs/push-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { handlePushRequest } from "~/lib/push/http.server";
import { registerPush } from "~/lib/push/subscriptions.server";
import { action as confirm } from "~/routes/auth-confirm";
import { action as logout } from "~/routes/logout";
import { action as settings, loader as settingsLoader } from "~/routes/settings";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { configurePush, identity, pushAuthorization, subscription } from "./helpers/push";
let h: RouteHarness;
beforeEach(async () => { configurePush(); h = await setupRouteHarness(); await h.signIn("push_api_reader"); await h.signIn("push_api_other"); });
afterEach(() => { h.restore(); vi.unstubAllEnvs(); });
function call(operation: string, value: unknown, as = "push_api_reader", extra: Record<string, string> = {}) {
  const headers = new Headers(h.request("/push/state", { as, headers: extra }).headers); headers.set("Content-Type", "application/json");
  return new Request(`http://localhost:5173/push/${operation}`, { method: "POST", headers, body: JSON.stringify(value) });
}
async function register(as = "push_api_reader") {
  const browser = identity(); const sub = subscription();
  const result = await handlePushRequest(call("subscribe", { identity: browser, subscription: sub }, as), "subscribe"); expect(result.status).toBe(200);
  return { browser, sub };
}
it("closes every push endpoint and settings section when the flag is empty", async () => {
  vi.stubEnv("WEB_PUSH", "");
  for (const operation of ["state", "subscribe", "unsubscribe", "test"]) expect((await handlePushRequest(call(operation, {}), operation)).status).toBe(404);
  expect(await settingsLoader(h.args(h.request("/settings", { as: "push_api_reader" })))).not.toHaveProperty("push");
});
it("requires a cookie session and exact origin and rejects oversized or malformed bodies", async () => {
  expect((await handlePushRequest(call("subscribe", {}, ""), "subscribe")).status).toBe(401);
  expect((await handlePushRequest(call("state", {}, "push_api_reader", { Authorization: "Bearer invented" }), "state")).status).toBe(403);
  const denied = await h.outcome(() => handlePushRequest(call("state", {}, "push_api_reader", { Origin: "https://sub.localhost:5173" }), "state")); expect(denied.status).toBe(403);
  expect((await handlePushRequest(call("state", { extra: "x".repeat(5000) }), "state")).status).toBe(413);
  expect((await handlePushRequest(call("subscribe", { identity: identity(), subscription: { endpoint: "https://127.0.0.1/x" } }), "subscribe")).status).toBe(400);
});
it("reconciles browser subscriptions, owns every cancellation, and uses stored targets for test sends", async () => {
  const f = await register();
  const state = await (await handlePushRequest(call("state", { identity: f.browser, subscription: f.sub }), "state")).json();
  expect(state.current.matchesSubscription).toBe(true); expect(state.registrations).toHaveLength(1);
  expect(JSON.stringify(state)).not.toContain(f.sub.endpoint); expect(JSON.stringify(state)).not.toContain(f.sub.keys.auth);
  expect((await handlePushRequest(call("unsubscribe", { id: f.browser.id }, "push_api_other"), "unsubscribe")).status).toBe(404);
  const send = vi.fn(async () => ({ kind: "accepted" as const }));
  expect((await handlePushRequest(call("test", { id: f.browser.id, identity: f.browser }, "push_api_other"), "test", { send })).status).toBe(404); expect(send).not.toHaveBeenCalled();
  for (let i = 0; i < 3; i++) expect((await handlePushRequest(call("test", { id: f.browser.id, identity: f.browser }), "test", { send })).status).toBe(200);
  expect((await h.outcome(() => handlePushRequest(call("test", { id: f.browser.id, identity: f.browser }), "test", { send }))).status).toBe(429);
  expect(send).toHaveBeenCalledTimes(3); expect((send.mock.calls[0] as unknown as [{ endpoint: string }])[0].endpoint).toBe(f.sub.endpoint);
});
it("stops the previous account only with the browser capability and requires another opt-in", async () => {
  const f = await register();
  const guessed = await handlePushRequest(call("state", { identity: { ...f.browser, secret: identity().secret } }, "push_api_other"), "state"); expect(guessed.status).toBe(200);
  expect((await h.db.select().from(pushSubscriptions))[0].stoppedReason).toBeNull();
  const changed = await (await handlePushRequest(call("state", { identity: f.browser }, "push_api_other"), "state")).json(); expect(changed.current).toBeNull();
  expect((await h.db.select().from(pushSubscriptions))[0].stoppedReason).toBe("account_changed");
});
it("stops other registrations independently of copied sessions and preserves the identified current browser", async () => {
  const first = await register(); const second = await register();
  await h.outcome(() => settings({ request: h.request("/settings", { as: "push_api_reader", form: { intent: "revoke-other-sessions", "push-id": first.browser.id, "push-secret": first.browser.secret } }) }));
  const rows = await h.db.select().from(pushSubscriptions); expect(rows.find(row => row.id === first.browser.id)?.stoppedReason).toBeNull(); expect(rows.find(row => row.id === second.browser.id)?.stoppedReason).toBe("other_sessions_revoked");
});
it("stops only the owned browser row on logout and preserves unrelated registration identity", async () => {
  const first = await register(); const second = await register();
  await logout(h.args(h.request("/logout", { as: "push_api_reader", form: { "push-id": first.browser.id, "push-secret": first.browser.secret } })));
  expect((await h.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, first.browser.id)))[0].stoppedReason).toBe("logout");
  expect((await h.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, second.browser.id)))[0].stoppedReason).toBeNull();
});

it("delivers a queued notification after reauthentication keeps its browser subscription authorized", async () => {
  const current = await register();
  const reader = h.ids.push_api_reader;
  const topic = await createTopic(h.db, reader, { lang: "ja", title: "Notification delivery", body: "Topic" });
  if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(h.db, h.ids.push_api_other, topic.id, { lang: "ja", body: "Reply" });
  if (!reply.ok) throw new Error(reply.error);
  const other = identity();
  await registerPush(h.db, reader, other, subscription(), "", await pushAuthorization(h.db, reader));
  const [before] = await h.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, other.id));

  const original = h.request("/", { as: "push_api_reader" }).headers;
  const token = await h.issueLink("push_api_reader@example.com", undefined, { reauthentication: true });
  const cookie = `${h.linkCookie(token)}; ${original.get("cookie")}`;
  const request = h.request("/auth/confirm", { form: { token }, headers: { cookie } });
  const response = await confirm(h.args(request)) as Response;
  expect(response.status).toBe(303);
  const nextCookie = response.headers.getSetCookie().find(value => value.startsWith("better-auth.session_token="))!.split(";")[0];
  const auth = await getAuth();
  const next = await auth.api.getSession({ headers: new Headers({ cookie: nextCookie }) });
  expect(next).toMatchObject({ user: { id: reader } });
  expect(await auth.api.getSession({ headers: original })).toBeNull();
  expect(await h.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, current.browser.id)))
    .toMatchObject([{ authorizingSessionId: next!.session.id, authorizedUntil: next!.session.expiresAt, generation: 1 }]);
  expect(await h.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, other.id))).toEqual([before]);

  const send = vi.fn(async () => ({ kind: "accepted" as const }));
  await runDueJobs(h.db, createPushHandlers({ send }), { now: new Date(Date.now() + 61_000) });
  expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endpoint: current.sub.endpoint }), expect.any(String), expect.any(Object));
});


it("rechecks the push recipient and current content before marking a notice read", async () => {
  await register();
  const { notifications, pushDeliveries, entries } = await import("~/lib/db/schema");
  const { loader: open } = await import("~/routes/notification-open");
  const topic = await createTopic(h.db, h.ids.push_api_reader, { lang: "ja", title: "Opening boundary", body: "Topic" }); if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(h.db, h.ids.push_api_other, topic.id, { lang: "ja", body: "Reply" }); if (!reply.ok) throw new Error(reply.error);
  await runDueJobs(h.db, createPushHandlers({ send: async () => ({ kind: "accepted" }) }), { now: new Date(Date.now() + 61000) });
  const [delivery] = await h.db.select().from(pushDeliveries); const path = `/notifications/${delivery.notificationId}/open?push=${delivery.id}`;
  const invoke = (as: string) => h.outcome(() => open(h.args(h.request(path, { as }), { id: String(delivery.notificationId) })));
  expect((await invoke("push_api_other")).status).toBe(404);
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, reply.id)); expect((await invoke("push_api_reader")).status).toBe(404);
  expect((await h.db.select().from(notifications).where(eq(notifications.id, delivery.notificationId)))[0].readAt).toBeNull();
  await h.db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, reply.id)); expect((await invoke("push_api_reader")).status).toBe(302);
  expect((await h.db.select().from(notifications).where(eq(notifications.id, delivery.notificationId)))[0].readAt).not.toBeNull();
});

it("returns structured rate limits and treats stopped or expired test targets as missing", async () => {
  const f = await register(); const send = vi.fn(async () => ({ kind: "accepted" as const }));
  const logger = vi.spyOn(console, "error").mockImplementation(() => {});
  await h.db.update(pushSubscriptions).set({ authorizedUntil: new Date(0) }).where(eq(pushSubscriptions.id, f.browser.id));
  expect((await handlePushRequest(call("test", { id: f.browser.id, identity: f.browser }), "test", { send })).status).toBe(404);
  await h.db.update(pushSubscriptions).set({ stoppedReason: "member_stopped", authorizedUntil: new Date(Date.now() + 60000) }).where(eq(pushSubscriptions.id, f.browser.id));
  expect((await handlePushRequest(call("test", { id: f.browser.id, identity: f.browser }), "test", { send })).status).toBe(404);
  expect(logger).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); logger.mockRestore();
  const { hitMemberLimit, MEMBER_RATE_LIMITS } = await import("~/lib/rate-limit.server");
  for (let i = 0; i < MEMBER_RATE_LIMITS["push-state"].limit; i++) await hitMemberLimit(h.db, "push-state", h.ids.push_api_reader);
  const rate = await handlePushRequest(call("state", { identity: f.browser }), "state");
  expect(rate.status).toBe(429); expect(await rate.json()).toEqual({ error: "limit" }); expect(rate.headers.get("Retry-After")).toBeTruthy();
});
it("does not let a stale test-send response change a stopped registration", async () => {
  const f = await register();
  const { stopPush } = await import("~/lib/push/subscriptions.server");
  const send = vi.fn(async () => { await stopPush(h.db, h.ids.push_api_reader, f.browser.id); return { kind: "gone" as const }; });
  expect((await handlePushRequest(call("test", { id: f.browser.id, identity: f.browser }), "test", { send })).status).toBe(503);
  const [row] = await h.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, f.browser.id));
  expect(row).toMatchObject({ stoppedReason: "member_stopped", generation: 2, endpoint: null });
});

it.each(["expired", "revoked"])("requires the registration's authorizing session for a test when %s", async condition => {
  const f = await register();
  const { session } = await import("~/lib/db/schema");
  const authorization = await pushAuthorization(h.db, h.ids.push_api_reader);
  await h.db.update(pushSubscriptions).set({ authorizingSessionId: authorization.sessionId }).where(eq(pushSubscriptions.id, f.browser.id));
  const send = vi.fn(async () => ({ kind: "accepted" as const }));
  expect((await handlePushRequest(call("test", { id: f.browser.id, identity: f.browser }), "test", { send })).status).toBe(200);
  if (condition === "expired") await h.db.update(session).set({ expiresAt: new Date(0) }).where(eq(session.id, authorization.sessionId));
  else await h.db.delete(session).where(eq(session.id, authorization.sessionId));
  expect((await handlePushRequest(call("test", { id: f.browser.id, identity: f.browser }), "test", { send })).status).toBe(404);
  expect(send).toHaveBeenCalledOnce();
});
