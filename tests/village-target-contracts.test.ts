import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { BASE, setupRouteHarness } from "./helpers/route-harness";
import { parseBlocks } from "./helpers/md";
import { getAuth } from "~/lib/auth/auth.server";
import { createApiToken } from "~/lib/tokens.server";
import { handleDraftCreate } from "~/lib/api/drafts-api.server";
import { handleMcpRequest } from "~/lib/mcp/server.server";
import { ensureLanguageVillages, changeVillageMembership, languageVillage, setDefaultVillage } from "~/lib/villages.server";
import { createDraft } from "~/lib/drafts.server";
import { draftMdMiddleware } from "~/lib/md/draft.server";
import * as draftService from "~/lib/drafts.server";
import { profiles, signingChallenges, villages, villageMembers } from "~/lib/db/schema";
import { action as signingAction } from "~/routes/signing";
import { llmsTxt, helpAiMd, aiTxt } from "~/lib/api/guides.server";
import { openApiDocument } from "~/lib/api/openapi.server";
import { MEMBER_FIXTURES, VILLAGE_MEMBER_FIXTURES } from "../e2e/member-fixtures";

let shared: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { shared = await setup(); });
beforeEach(async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en");
  await shared.h.db.update(profiles).set({ defaultVillageId: (await languageVillage(shared.h.db, "ja"))!.id }).where(eq(profiles.userId, shared.h.ids.vt_owner));
});
afterAll(() => shared.h.restore());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("gates AI destination guidance and keeps new members out of private browser seeds", () => {
  vi.stubEnv("VILLAGES", "");
  const old = { llms: llmsTxt(), help: helpAiMd(), policy: aiTxt(), api: openApiDocument() };
  const privateMembers = MEMBER_FIXTURES.filter(member => !VILLAGE_MEMBER_FIXTURES.includes(member));
  expect(privateMembers.some(member => member.handle.startsWith("vtarget_"))).toBe(false);
  for (const member of VILLAGE_MEMBER_FIXTURES) expect(member.handle).not.toMatch(/^(?:b|be|m|ha|jo)/);
  vi.stubEnv("VILLAGES", "1");
  for (const text of [llmsTxt(), helpAiMd()]) for (const term of ["/villages.md", "/v/<slug>.md", "village_required", "tomola_draft_update"]) expect(text).toContain(term);
  const api = openApiDocument() as { paths: Record<string, unknown>; components: { schemas: { DraftCreated: { properties: Record<string, unknown> } } } };
  expect(api.paths).toHaveProperty("/villages.md");
  expect(api.components.schemas.DraftCreated.properties).toHaveProperty("village");
  expect(aiTxt()).toBe(old.policy);
  vi.stubEnv("VILLAGES", "");
  expect({ llms: llmsTxt(), help: helpAiMd(), policy: aiTxt(), api: openApiDocument() }).toEqual(old);
});
async function setup() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en");
  const h = await setupRouteHarness();
  await ensureLanguageVillages(h.db);
  await h.signIn("vt_owner", { homeArea: "ja" });
  await changeVillageMembership(h.db, h.ids.vt_owner, "en", "join");
  const token = await createApiToken(h.db, h.ids.vt_owner, { name: "Destination contract", kind: "draft" });
  if (!token.ok) throw new Error(token.error);
  return { h, token: token.token };
}

it("extends the existing HTTP creation and MCP create/update contracts without expanding client ownership", async () => {
  const { h, token } = shared;
  const post = (village: string) => handleDraftCreate(new Request(BASE + "/api/drafts", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/markdown" }, body: `---\nlang: en\nvillage: ${JSON.stringify(village)}\n---\nContract body.` }), { db: h.db });
  const created = await post("en");
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ village: "en" });
  const rows = await h.db.insert(villages).values([
    { slug: "not-joined", name: "Unjoined", kind: "open" },
    { slug: "ended-target", name: "Ended", kind: "open", endedAt: new Date() },
    { slug: "private-target", name: "Private", kind: "closed" },
  ]).returning();
  await h.db.insert(villageMembers).values(rows.filter(r => r.slug !== "not-joined").map(r => ({ villageId: r.id, userId: h.ids.vt_owner })));
  const failures: unknown[] = [];
  for (const slug of ["not-joined", "ended-target", "private-target", "missing-target", "@another_member"]) {
    const response = await post(slug);
    expect(response.status).toBe(400);
    failures.push(await response.json());
  }
  expect(failures.every(f => JSON.stringify(f) === JSON.stringify(failures[0]))).toBe(true);
  expect(failures[0]).toMatchObject({ error: "village_required" });
  const auth = await getAuth();
  const rpc = async (method: string, params: Record<string, unknown>, bearer = token) => {
    const response = await handleMcpRequest(new Request(BASE + "/mcp", { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "Contract fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } } }) }), { db: h.db, auth, baseURL: BASE });
    expect(response.status).toBe(200);
    return (await response.json()).result;
  };
  const tools = (await rpc("tools/list", {})).tools;
  for (const name of ["tomola_draft_create", "tomola_draft_update"]) expect(tools.find((t: { name: string }) => t.name === name).inputSchema.properties).toHaveProperty("village");
  const call = (name: string, args: Record<string, unknown>, bearer = token) => rpc("tools/call", { name, arguments: args }, bearer);
  const view = (result: { content: { text: string }[] }) => JSON.parse(parseBlocks(result.content[0].text)[0].body);
  const saved = view(await call("tomola_draft_create", { kind: "topic", body: "MCP destination body.", lang: "en", village: "en" }));
  expect(saved).toMatchObject({ village: "en", version: 1 });
  expect(view(await call("tomola_draft_update", { id: saved.id, expectedVersion: saved.version, village: "ja" }))).toMatchObject({ village: "ja", version: 2 });
  const other = await createApiToken(h.db, h.ids.vt_owner, { name: "Other client", kind: "draft" });
  if (!other.ok) throw new Error(other.error);
  const wrongClient = await call("tomola_draft_update", { id: saved.id, expectedVersion: 2, village: "en" }, other.token);
  expect(wrongClient).toMatchObject({ isError: true });
  expect(parseBlocks(wrongClient.content[0].text)[0].body.trim().split(":")[0]).toBe("not_found");
  expect(view(await call("tomola_draft_get", { id: saved.id }))).toMatchObject({ village: "ja", version: 2 });
  const missingVillage = await call("tomola_draft_update", { id: saved.id, expectedVersion: 2, village: "missing-target" });
  expect(missingVillage).toMatchObject({ isError: true });
  expect(parseBlocks(missingVillage.content[0].text)[0].body.trim().split(":")[0]).toBe("village_required");
  expect(view(await call("tomola_draft_get", { id: saved.id }))).toMatchObject({ village: "ja", version: 2 });
  vi.stubEnv("VILLAGES", "");
  const off = await post("{invalid: ignored}");
  expect(off.status).toBe(201);
  const offBody = await off.json();
  expect(Object.keys(offBody).sort()).toEqual(["approve_url", "id", "issues", "issues_truncated", "lang", "lang_code", "language"]);
  expect(offBody).toMatchObject({ lang: "en", lang_code: null });
  for (const name of ["tomola_draft_create", "tomola_draft_update"]) expect((await rpc("tools/list", {})).tools.find((t: { name: string }) => t.name === name).inputSchema.properties).not.toHaveProperty("village");
  expect(view(await call("tomola_draft_create", { kind: "topic", body: "Ignored off target.", village: "missing-target" }))).not.toHaveProperty("village");
});

it("serves draft Markdown to its owner only and leaves the old route untouched when disabled", async () => {
  const { h, token } = shared;
  await h.signIn("vt_reader");
  const saved = await createDraft(h.db, h.ids.vt_owner, { kind: "topic", body: "Owned text.", lang: "en", village: "en" });
  if (!saved.ok) throw new Error(saved.error);
  const next = vi.fn(async () => new Response("original"));
  const read = (as?: string, headers?: Record<string, string>, method = "GET") => draftMdMiddleware({ request: new Request(h.request(`/drafts/${saved.id}.md`, { as, headers }), { method }), params: { id: `${saved.id}.md` } }, next);
  const response = await read("vt_owner");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-ratelimit-limit")).toBe("600");
  expect(Number(response.headers.get("x-ratelimit-remaining"))).toBeGreaterThanOrEqual(0);
  expect(Number(response.headers.get("x-ratelimit-reset"))).toBeGreaterThan(0);
  expect(parseBlocks(await response.text())[0]).toMatchObject({ fm: { village: "en" }, body: "Owned text." });
  for (const [header, value] of Object.entries({ "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex", "x-content-type-options": "nosniff", vary: "Authorization, Cookie" })) expect(response.headers.get(header)).toBe(value);
  expect(await (await read("vt_owner", undefined, "HEAD")).text()).toBe("");
  expect((await h.outcome(() => read("vt_reader"))).status).toBe(404);
  expect(await (await read("vt_reader")).text()).toBe("404 not_found\n\nNot found.\n");
  expect((await h.outcome(() => read(undefined, { authorization: `Bearer ${token}` }))).status).toBe(401);
  expect((await read(undefined, undefined, "POST")).status).toBe(405);
  const method = await read("vt_owner", undefined, "POST");
  expect(method.status).toBe(405); expect(method.headers.get("allow")).toBe("GET, HEAD");
  expect(await method.text()).toContain("405 method_not_allowed");
  vi.spyOn(draftService, "getDraft").mockRejectedValueOnce(new Error("private failure details"));
  const failed = await read("vt_owner");
  expect(failed.status).toBe(500); expect(await failed.text()).not.toContain("private failure details");
  expect(failed.headers.get("x-robots-tag")).toBe("noindex");
  vi.stubEnv("VILLAGES", "");
  expect(await (await read("vt_owner")).text()).toBe("original");
  expect(next).toHaveBeenCalledOnce();
});

it("returns the public destination on draft review and only its slug on a conflict", async () => {
  const { h } = shared, userId = h.ids.vt_owner;
  const draft = await createDraft(h.db, userId, { kind: "topic", body: "Reviewed draft target", lang: "en", village: "en" }, { via: "api" });
  if (!draft.ok) throw new Error(draft.error);
  const pathname = `/drafts/${draft.id}`;
  const fields = { intent: "publish", version: "1", body: "Reviewed draft target", lang: "en", village: "", villageExplicit: "0", villageDisplayed: "ja" };
  const request = (overrides: Record<string, string> = {}) => {
    const original = h.request("/signing", { as: "vt_owner" });
    return signingAction(h.args(new Request(original, { method: "POST", body: JSON.stringify({ intent: "preview", pathname, fields: Object.entries({ ...fields, ...overrides }) }) })));
  };
  const conflict = await request();
  expect(conflict.status).toBe(409);
  expect(conflict.headers.get("cache-control")).toBe("private, no-store");
  expect(await conflict.json()).toEqual({ error: "village_changed", village: "en" });
  const response = await request({ villageDisplayed: "  EN  " });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ village: { slug: "en" }, confirmation: expect.any(String), signatureRequired: false });

  const unavailable = await h.db.insert(villages).values([
    { slug: "review-closed", name: "Private target", kind: "closed" },
    { slug: "review-unjoined", name: "Unjoined target", kind: "open" },
    { slug: "review-ended", name: "Ended target", kind: "open", endedAt: new Date() },
  ]).returning();
  await h.db.insert(villageMembers).values(unavailable.filter(row => row.slug !== "review-unjoined").map(row => ({ villageId: row.id, userId })));
  for (const village of unavailable) {
    const response = await request({ village: village.slug!, villageExplicit: "1" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "village_required" });
  }
  expect(await h.db.select().from(signingChallenges)).toEqual([]);
});
