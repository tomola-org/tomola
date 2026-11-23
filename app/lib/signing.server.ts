import { isDeletedIdentity } from "./deleted-member";
import { withEntryRender } from "./entry-render-preparation.server";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON, type AuthenticatorTransportFuture } from "@simplewebauthn/server";
import type { Db, Tx } from "~/lib/db/client.server";
import { drafts, entries, passkey, profiles, user } from "~/lib/db/schema";
import { applyPastedFrontmatter, formString, readEntryForm, readReplyParent } from "~/lib/entry-form.server";
import { detectSourceLanguage, resolvePostLanguage } from "~/lib/lang-detect";
import { defaultPostLang, type Profile } from "~/lib/profiles.server";
import { authSecret } from "~/lib/auth/secret.server";
import { siteUrl } from "~/lib/site-url";
import { normalizeNewlines, titleOrNull } from "~/lib/text";
import { checkEntryInput, getEntryViews } from "~/lib/entries.server";
import { undeletedTopic } from "~/lib/visibility.server";
import { readMentionBindings } from "~/lib/mentions.server";
import { checkBodyBudget } from "~/lib/markdown.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { lockVillageProfile, previewVillageForTopic, villageForTopic, villageSlug, type PublicVillage } from "~/lib/villages.server";
import { DRAFT_CONFIRMATION_FIELD, needsDraftConfirmation, SIGNING_VIEW_FIELD, type SigningContent, type WriteOperation, type SigningPreview } from "./signing";

export const SIGNING_TTL_MS = 2 * 60 * 1000;
const DRAFT_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export class SigningError extends Error {
  constructor(readonly code: string, readonly status = 403, readonly village?: string) { super(code); }
}
export class SigningFailureResponse extends Response {
  readonly code: string;
  readonly village?: string;
  constructor(error: SigningError) {
    super(JSON.stringify({ error: error.code, ...(error.village ? { village: error.village } : {}) }), {
      status: error.status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
    this.code = error.code;
    this.village = error.village;
  }
}
export function signingErrorResponse(error: SigningError): Response {
  return new SigningFailureResponse(error);
}
export const signingSite = () => { const u = new URL(siteUrl()); return { origin: u.origin, rpId: u.hostname }; };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// Stable object ordering keeps existing confirmation and passkey bindings valid. Arrays keep their order; undefined is never accepted as a public value.
export function canonicalSigningJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSigningJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, val]) => `${JSON.stringify(key)}:${canonicalSigningJson(val)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new SigningError("invalid_payload", 400);
  return encoded;
}

// Serialize login-counter updates, enrollment, recovery, and browser writes on the same member row. NO KEY UPDATE is compatible with unrelated foreign-key checks.
export async function lockSigningMember(tx: Tx, userId: string): Promise<void> {
  const [member] = await tx.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, userId)).for("no key update");
  if (!member || isDeletedIdentity(member.id, member.email)) throw new SigningError("not_a_member");
}

type Viewed = SigningContent & { userId: string; kind: "draft"; id: number; version: string };
export function signingViewToken(input: Viewed): string {
  const text = Buffer.from(canonicalSigningJson(input)).toString("base64url");
  return `${text}.${createHmac("sha256", authSecret()).update(`signing-view:${text}`).digest("base64url")}`;
}
function readView(form: FormData, userId: string, id: number): Viewed | null {
  const token = formString(form, SIGNING_VIEW_FIELD);
  if (!token) return null;
  const [text, mac, extra] = token.split(".");
  if (!text || !mac || extra) throw new SigningError("invalid_view", 400);
  const expected = createHmac("sha256", authSecret()).update(`signing-view:${text}`).digest();
  const actual = Buffer.from(mac, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new SigningError("invalid_view", 400);
  let view: Viewed;
  try { view = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Viewed; } catch { throw new SigningError("invalid_view", 400); }
  if (view.userId !== userId || view.kind !== "draft" || view.id !== id || typeof view.body !== "string") throw new SigningError("invalid_view", 400);
  return view;
}

function assertDraftPreviewPublication(form: FormData, userId: string, draft: { id: number; version: number; kind: string; title: string | null; body: string; lang: string; asksStance: boolean }) {
  const view = readView(form, userId, draft.id);
  const raw = readEntryForm(form);
  if (draft.kind !== "topic" || view?.version !== String(draft.version) || formString(form, "version") !== view.version
    || view.body !== draft.body || view.title !== titleOrNull(draft.title) || view.lang !== draft.lang
    || raw.body !== normalizeNewlines(draft.body) || titleOrNull(raw.title) !== view.title || raw.lang !== view.lang || raw.asksStance !== draft.asksStance) {
    throw new SigningError("draft_conflict", 409);
  }
}

const contentOf = (row: { title: string | null; body: string; lang: string }): SigningContent => ({ title: titleOrNull(row.title), body: row.body, lang: row.lang });
const publicTitle = (title: string | null) => title?.trim() || null;

type DraftRow = typeof drafts.$inferSelect;
type FormInput = ReturnType<typeof readEntryForm>;
type DraftPublicationInput = Omit<FormInput, "title" | "altOf"> & { title: string | null };

function lockPublicationDraft(tx: Tx, userId: string, id: number) {
  return tx.select().from(drafts).where(and(eq(drafts.id, id), eq(drafts.authorId, userId))).for("update");
}

async function assertDraftPreviewForm(db: Db, form: FormData, userId: string, draft: DraftRow, raw: FormInput) {
  assertDraftPreviewPublication(form, userId, draft);
  if (villagesEnabled()) {
    const village = await villageSlug(db, draft.villageId);
    if (raw.villageExplicit !== Boolean(village) || (raw.village ?? "") !== (village ?? "")) throw new SigningError("draft_conflict", 409);
  }
}

async function draftPublication(db: Db, draft: DraftRow, raw: DraftPublicationInput, { tx, confirm = false }: { tx?: Tx; confirm?: boolean } = {}) {
  const lang = confirm && raw.lang === "other" ? (await resolvePostLanguage(raw.body, raw.lang, raw.lang)).lang : raw.lang;
  const content = { title: draft.kind === "topic" ? publicTitle(raw.title) : null, body: raw.body, lang };
  let stanceTag: string | null = draft.stanceTag;
  if (draft.kind === "reply" && draft.threadId !== null) {
    const [topic] = await db.select({ asksStance: entries.asksStance }).from(entries).where(eq(entries.id, draft.threadId));
    if (topic?.asksStance) stanceTag = raw.stanceTag;
  }
  const slug = raw.villageExplicit === false ? undefined : raw.village;
  const stored = raw.villageExplicit === false || raw.village === undefined ? draft.villageId : null;
  const destination = villagesEnabled() && draft.kind === "topic"
    ? await (tx ? villageForTopic(tx, draft.authorId, slug, stored) : previewVillageForTopic(db, draft.authorId, slug, stored))
    : undefined;
  if (destination === null) throw new SigningError("village_required", 400);
  const villageId = destination?.id;
  const target = { draftId: draft.id, threadId: draft.threadId, parentId: draft.parentId, altOf: draft.altOf, ...(villageId ? { villageId } : {}) };
  const input = { ...content, asksStance: draft.kind === "topic" ? raw.asksStance : draft.asksStance, stanceTag, aiAssistance: draft.aiAssistance, via: draft.via, ...(destination ? { village: destination.slug } : {}) };
  const village: PublicVillage | undefined = destination && {
    slug: destination.slug, kind: destination.kind, name: destination.name, description: destination.description, language: destination.language,
  };
  return { content, target, input, village, baseVersion: draft.version };
}

type DraftPublication = Awaited<ReturnType<typeof draftPublication>>;

function assertDraftVillageDisplay(publication: DraftPublication, raw: Pick<FormInput, "villageDisplayed">) {
  const slug = publication.village?.slug;
  if (slug && (raw.villageDisplayed ?? "").trim().toLowerCase() !== slug) throw new SigningError("village_changed", 409, slug);
}

function confirmationHash(actor: string, { target, input, baseVersion }: DraftPublication): string {
  return sha256(canonicalSigningJson({
    v: 1, actor, operation: "publish-draft",
    target: { ...target, villageId: target.villageId ?? null },
    baseVersion,
    input: { ...input, village: input.village ?? null },
  }));
}

function confirmationMac(userId: string, hash: string, expiresAt: string) {
  return createHmac("sha256", authSecret()).update(`confirm:v1|${userId}|${hash}|${expiresAt}`).digest("base64url");
}

function draftConfirmation(userId: string, publication: DraftPublication, now = Date.now()): string {
  const expiresAt = String(now + DRAFT_CONFIRMATION_TTL_MS);
  return `${expiresAt}.${confirmationMac(userId, confirmationHash(userId, publication), expiresAt)}`;
}

function assertDraftConfirmation(userId: string, token: string, publication: DraftPublication, now: Date) {
  const parts = /^([0-9]{1,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!parts || !timingSafeEqual(Buffer.from(parts[2]), Buffer.from(confirmationMac(userId, confirmationHash(userId, publication), parts[1])))) {
    throw new SigningError("confirmation_changed", 409);
  }
  if (Number(parts[1]) <= now.getTime()) throw new SigningError("confirmation_expired", 409);
}

export async function confirmationForDraftPreview(db: Db, draft: DraftRow, posting: { selected: string; explicit: boolean } | null, now?: number) {
  const raw: DraftPublicationInput = {
    title: draft.title === null ? null : normalizeNewlines(draft.title), body: normalizeNewlines(draft.body),
    lang: draft.lang, asksStance: draft.asksStance, stanceTag: draft.stanceTag,
    ...(posting ? { village: posting.explicit ? posting.selected : "", villageExplicit: posting.explicit, villageDisplayed: posting.selected } : {}),
  };
  try {
    const publication = await draftPublication(db, draft, raw, { confirm: true });
    assertDraftVillageDisplay(publication, raw);
    return draftConfirmation(draft.authorId, publication, now);
  } catch (error) {
    // The preview can still display an unavailable posting destination.
    if (!(error instanceof SigningError) || (error.code !== "village_required" && error.code !== "village_changed")) throw error;
    return undefined;
  }
}
export function routeOperation(path: string, form: FormData): { operation: WriteOperation; id: number | null } {
  const intent = formString(form, "intent");
  if (path === "/t/new" && intent !== "draft") return { operation: "create-topic", id: null };
  let match = /^\/t\/(\d+)$/.exec(path);
  if (match && !["draft", "delete", "report", "flag"].includes(intent)) return { operation: "create-reply", id: Number(match[1]) };
  match = /^\/t\/(\d+)\/edit$/.exec(path);
  if (match) return { operation: "edit-topic", id: Number(match[1]) };
  match = /^\/c\/(\d+)\/edit$/.exec(path);
  if (match) return { operation: "edit-reply", id: Number(match[1]) };
  if (/^\/mcp\/entry-edits\/\d+$/.test(path)) {
    const kind = formString(form, "entryKind");
    const entryId = formString(form, "entryId");
    if ((kind === "topic" || kind === "reply") && /^[1-9]\d{0,15}$/.test(entryId) && Number.isSafeInteger(Number(entryId))) {
      return { operation: kind === "topic" ? "edit-topic" : "edit-reply", id: Number(entryId) };
    }
    throw new SigningError("invalid_target", 400);
  }
  match = /^\/drafts\/(\d+)(?:\/preview)?$/.exec(path);
  if (match && intent === "publish") return { operation: "publish-draft", id: Number(match[1]) };
  if (path === "/settings" && intent === "display-name") return { operation: "change-display-name", id: null };
  if (path === "/settings" && intent === "handle") return { operation: "change-handle", id: null };
  if (path === "/settings" && intent === "delete-passkey") return { operation: "remove-passkey", id: null };
  if (path === "/settings/delete-account" && intent === "delete-account") return { operation: "delete-account", id: null };
  throw new SigningError("invalid_target", 400);
}

export async function previewDraftPublication(db: Db, userId: string, pathname: string, form: FormData): Promise<SigningPreview> {
  return db.transaction(async tx => {
    await lockSigningMember(tx, userId);
    const { operation, id } = routeOperation(pathname, form);
    if (operation !== "publish-draft" || id === null || !Number.isSafeInteger(id) || id < 1) throw new SigningError("invalid_target", 400);
    if (villagesEnabled()) await lockVillageProfile(tx, userId);
    const [draft] = await lockPublicationDraft(tx, userId, id);
    if (!draft) throw new SigningError("not_found", 404);
    const raw = readEntryForm(form);
    if (pathname.endsWith("/preview")) assertDraftPreviewPublication(form, userId, draft);
    const confirm = needsDraftConfirmation(draft);
    if (confirm && Number(formString(form, "version")) !== draft.version) throw new SigningError("draft_conflict", 409);
    const publication = await draftPublication(tx, draft, raw, { tx, confirm: true });
    assertDraftVillageDisplay(publication, raw);
    const { target, content, village } = publication;
    const viewed = readView(form, userId, draft.id);
    const current = contentOf(draft);
    const bodyError = await checkBodyBudget(content.body, userId);
    if (bodyError) throw new SigningError(bodyError, 400);
    const detected = content.lang ? await detectSourceLanguage(content.body, content.lang) : null;
    const language = content.lang ? { source: "explicit" as const, detected: detected?.lang ?? null, ...(detected?.lang === "other" ? { langCode: detected.langCode } : {}) } : null;
    const lastEditor = { id: draft.clientId ?? (draft.via === "api" ? `token:${draft.tokenId ?? "deleted"}` : null), name: draft.clientName, uri: draft.clientUri, at: (draft.clientUpdatedAt ?? (draft.via === "api" ? draft.updatedAt : null))?.toISOString() ?? null };
    const targetContext = await draftTargetContext(tx, target);
    return {
      operation, content, language, current, target, lastEditor, targetContext, signatureRequired: false,
      viewed: viewed ? { title: viewed.title, body: viewed.body, lang: viewed.lang } : null,
      ...(village ? { village } : {}),
      ...(confirm ? { confirmation: draftConfirmation(userId, publication) } : {}),
    };
  });
}

async function draftTargetContext(tx: Tx, target: SigningPreview["target"]) {
  const destinationId = target.threadId ?? target.altOf;
  const targetIds = [destinationId, target.parentId].filter((id): id is number => id !== null);
  const targetViews = await getEntryViews(tx, targetIds);
  const targetContent = (id: number | null): SigningContent | null => {
    const row = id === null ? undefined : targetViews.get(id);
    return row?.visibility === "visible" ? contentOf(row) : null;
  };
  // The preview echoes target text back to the member, so it may only show what an ordinary read of the same target would show.
  // A visible reply under a hidden topic is such a read: the topic page shows it too, so it stays available as the parent here.
  // The destination must be a topic that is not deleted; the parent must be a reply that belongs to that topic. Ids that do not fit are not looked up for content.
  const [destination] = destinationId === null ? [] : await tx.select({ id: entries.id }).from(entries)
    .where(and(eq(entries.id, destinationId), undeletedTopic()));
  const destinationOk = destination !== undefined;
  let parentOk = false;
  if (destinationOk && target.threadId !== null && target.parentId !== null) {
    const [parentRow] = await tx.select({ kind: entries.kind, threadId: entries.threadId }).from(entries).where(eq(entries.id, target.parentId));
    parentOk = parentRow?.kind === "reply" && parentRow.threadId === target.threadId;
  }
  return { thread: destinationOk ? targetContent(destinationId) : null, parent: parentOk ? targetContent(target.parentId) : null };
}

export function boundChallenge(payloadHash: string): string {
  return Buffer.from(`tomola:v1:${randomBytes(32).toString("hex")}:${payloadHash}`, "utf8").toString("base64url");
}
export function transportsOf(value: string | null): AuthenticatorTransportFuture[] | undefined {
  return value ? value.split(",") as AuthenticatorTransportFuture[] : undefined;
}
export async function verifySignedAssertion(tx: Tx, userId: string, challenge: string, response: AuthenticationResponseJSON) {
  if (!response || typeof response.id !== "string") throw new SigningError("invalid_signature");
  const [key] = await tx.select().from(passkey).where(and(eq(passkey.userId, userId), eq(passkey.credentialID, response.id))).for("update");
  if (!key) throw new SigningError("wrong_passkey");
  let verified;
  try { verified = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: signingSite().origin, expectedRPID: signingSite().rpId, requireUserVerification: true, credential: { id: key.credentialID, publicKey: new Uint8Array(Buffer.from(key.publicKey, "base64url")), counter: key.counter, transports: transportsOf(key.transports) } }); }
  catch { throw new SigningError("invalid_signature"); }
  if (!verified.verified || !verified.authenticationInfo.userVerified) throw new SigningError("user_verification_required");
  await tx.update(passkey).set({ counter: verified.authenticationInfo.newCounter, backedUp: verified.authenticationInfo.credentialBackedUp }).where(eq(passkey.id, key.id));
  return key;
}

type MutationResult = { ok: boolean; id?: number };
const memberWriteLock = Symbol("memberWriteLock");
export type LockedMemberWrite = {
  readonly [memberWriteLock]: true;
  readonly tx: Tx;
  readonly userId: string;
  readonly operation: WriteOperation;
  readonly id: number | null;
};

// With a transactional database, the write boundary is a savepoint.
export async function withMemberWrite<T extends MutationResult>(db: Db, userId: string, request: Request, form: FormData, mutate: (tx: Tx, write: LockedMemberWrite) => Promise<T>, opts: { now?: Date; prepareRender?: boolean } = {}): Promise<T> {
  try {
    // React Router uses the route's .data transport URL for hydrated submissions.
    const pathname = new URL(request.url).pathname.replace(/\.data$/, "");
    const { operation, id } = routeOperation(pathname, form);
    const run = () => db.transaction(async tx => {
      await lockSigningMember(tx, userId);
      const [profile] = await tx.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.userId, userId));
      if (!profile) throw new SigningError("not_a_member");
      const perform = (writeTx: Tx) => mutate(writeTx, { [memberWriteLock]: true, tx: writeTx, userId, operation, id });
      return operation === "publish-draft"
        ? publishReviewedDraft(tx, userId, id!, pathname.endsWith("/preview"), form, perform, opts.now)
        : perform(tx);
    });
    return await (opts.prepareRender === false ? run() : prepareEntryRender(db, userId, operation, id, form, run));
  } catch (error) {
    if (error instanceof SigningError) throw signingErrorResponse(error);
    throw error;
  }
}

async function prepareEntryRender<T>(db: Db, userId: string, operation: WriteOperation, id: number | null, form: FormData, run: () => Promise<T>): Promise<T> {
  if (operation === "create-topic" || operation === "create-reply") {
    const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId));
    if (!profile) return run();
    const kind = operation === "create-topic" ? "topic" : "reply";
    const raw = readEntryForm(form);
    const pasted = await applyPastedFrontmatter(raw, kind, { defaultLang: defaultPostLang(profile as unknown as Profile), ...(id === null ? {} : { threadId: id }), parentId: kind === "reply" ? readReplyParent(form) : undefined });
    if (!pasted.ok || await checkEntryInput(kind, pasted.input, userId)) return run();
    return withEntryRender(db, { kind, body: pasted.input.body, lang: pasted.input.lang }, run, userId);
  }
  if (operation === "edit-topic" || operation === "edit-reply") {
    const [entry] = await db.select().from(entries).where(and(eq(entries.id, id!), eq(entries.authorId, userId)));
    if (entry) {
      const raw = readEntryForm(form);
      const previous = await readMentionBindings(db, entry.id, entry.mentionRevision);
      if (!await checkBodyBudget(raw.body, userId)) return withEntryRender(db, { kind: entry.kind as "topic" | "reply", id: entry.id, body: raw.body, lang: raw.lang || entry.lang, previous }, run, userId);
    }
  }
  if (operation === "publish-draft") {
    const [draft] = await db.select().from(drafts).where(and(eq(drafts.id, id!), eq(drafts.authorId, userId)));
    const raw = readEntryForm(form);
    if (draft && !await checkBodyBudget(raw.body, userId)) return withEntryRender(db, { kind: draft.kind as "topic" | "reply", body: raw.body, lang: raw.lang }, run, userId);
  }
  return run();
}
type ApprovedEntry = { input: Record<string, unknown>; target: Pick<SigningPreview["target"], "parentId" | "altOf" | "threadId" | "villageId"> };

function assertPublishedEntry(entry: typeof entries.$inferSelect, approved: ApprovedEntry) {
  for (const field of ["title", "body", "lang", "asksStance", "aiAssistance", "stanceTag"] as const) {
    if (field in approved.input && approved.input[field] !== entry[field]) throw new SigningError("published_content_changed", 409);
  }
  if (entry.parentId !== approved.target.parentId || entry.altOf !== approved.target.altOf || (entry.kind === "reply" && entry.threadId !== approved.target.threadId)) throw new SigningError("published_target_changed", 409);
  if (villagesEnabled() && "villageId" in approved.target && entry.villageId !== approved.target.villageId) throw new SigningError("published_target_changed", 409);
}

async function publishReviewedDraft<T extends MutationResult>(
  tx: Tx, userId: string, id: number, fromPreview: boolean, form: FormData, mutate: (tx: Tx) => Promise<T>, now?: Date,
): Promise<T> {
  if (villagesEnabled()) await lockVillageProfile(tx, userId);
  const [draft] = await lockPublicationDraft(tx, userId, id);
  if (!draft) throw new SigningError("not_found", 404);
  const raw = readEntryForm(form);
  if (fromPreview) await assertDraftPreviewForm(tx, form, userId, draft, raw);
  let publication: DraftPublication | undefined;
  if (needsDraftConfirmation(draft)) {
    const token = formString(form, DRAFT_CONFIRMATION_FIELD);
    if (!token) throw new SigningError("confirmation_required", 409);
    if (Number(formString(form, "version")) !== draft.version) throw new SigningError("confirmation_changed", 409);
    try { publication = await draftPublication(tx, draft, raw, { tx, confirm: true }); }
    catch (error) {
      if (error instanceof SigningError && error.code === "village_required") throw new SigningError("confirmation_changed", 409);
      throw error;
    }
    assertDraftConfirmation(userId, token, publication, now ?? new Date());
    assertDraftVillageDisplay(publication, raw);
  }
  const result = await mutate(tx);
  if (publication && result.ok) {
    const [entry] = result.id === undefined ? [] : await tx.select().from(entries).where(eq(entries.id, result.id));
    if (!entry || entry.authorId !== userId || entry.kind !== draft.kind) throw new SigningError("published_target_changed", 409);
    assertPublishedEntry(entry, publication);
  }
  return result;
}
