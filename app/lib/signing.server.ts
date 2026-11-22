import { parseDisplayNames } from "./display-names.server";
import { isDeletedIdentity } from "./deleted-member";
import { withEntryRender } from "./entry-render-preparation.server";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON, type AuthenticatorTransportFuture } from "@simplewebauthn/server";
import type { Db, Tx } from "~/lib/db/client.server";
import { drafts, entries, memberSignatures, passkey, profiles, signingChallenges, user, villageMembers, villages } from "~/lib/db/schema";
import { applyPastedFrontmatter, formString, readEntryForm, readReplyParent } from "~/lib/entry-form.server";
import { detectSourceLanguage, resolvePostLanguage } from "~/lib/lang-detect";
import { defaultPostLang, type Profile } from "~/lib/profiles.server";
import { authSecret } from "~/lib/auth/secret.server";
import { siteUrl } from "~/lib/site-url";
import { normalizeNewlines, titleOrNull } from "~/lib/text";
import { sourceHash } from "~/lib/source-hash.server";
import { checkEntryInput, getEditableEntry, getEntryViews } from "~/lib/entries.server";
import { lockReferenceTopics } from "~/lib/related-discussions.server";
import { undeletedTopic } from "~/lib/visibility.server";
import { readMentionBindings } from "~/lib/mentions.server";
import { checkBodyBudget } from "~/lib/markdown.server";
import { getViewer } from "~/lib/roles.server";
import { m } from "~/paraglide/messages.js";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { lockVillageProfile, previewVillageForTopic, villageForTopic, villageSlug, type PublicVillage } from "~/lib/villages.server";
import { DRAFT_CONFIRMATION_FIELD, needsDraftConfirmation, SIGNATURE_ASSERTION_FIELD, SIGNATURE_CHALLENGE_FIELD, SIGNING_VIEW_FIELD, type SigningContent, type SigningOperation, type SigningOptions, type SigningPreview } from "./signing";

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

// Stable object ordering is part of the public evidence format. Arrays keep their order; undefined is never accepted as a public value.
export function canonicalSigningJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSigningJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, val]) => `${JSON.stringify(key)}:${canonicalSigningJson(val)}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new SigningError("invalid_payload", 400);
  return encoded;
}

export function signingFormHash(form: FormData): string {
  const pairs: [string, string][] = [];
  for (const [key, value] of form.entries()) {
    if (key === SIGNATURE_ASSERTION_FIELD || key === SIGNATURE_CHALLENGE_FIELD || (key === DRAFT_CONFIRMATION_FIELD && form.get("intent") === "publish")) continue;
    if (typeof value !== "string") throw new SigningError("invalid_payload", 400);
    pairs.push([key, normalizeNewlines(value)]);
  }
  pairs.sort(([a], [b]) => a.localeCompare(b, "en"));
  return sha256(canonicalSigningJson(pairs));
}

// Serialize login-counter updates, enrollment, recovery, and signed writes on the same member row. NO KEY UPDATE is compatible with unrelated foreign-key checks.
export async function lockSigningMember(tx: Tx, userId: string): Promise<void> {
  const [member] = await tx.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, userId)).for("no key update");
  if (!member || isDeletedIdentity(member.id, member.email)) throw new SigningError("not_a_member");
}

type Viewed = SigningContent & { userId: string; kind: "draft" | "entry"; id: number; version: string };
export function signingViewToken(input: Viewed): string {
  const text = Buffer.from(canonicalSigningJson(input)).toString("base64url");
  return `${text}.${createHmac("sha256", authSecret()).update(`signing-view:${text}`).digest("base64url")}`;
}
function readView(form: FormData, userId: string, kind: Viewed["kind"], id: number): Viewed | null {
  const token = formString(form, SIGNING_VIEW_FIELD);
  if (!token) return null;
  const [text, mac, extra] = token.split(".");
  if (!text || !mac || extra) throw new SigningError("invalid_view", 400);
  const expected = createHmac("sha256", authSecret()).update(`signing-view:${text}`).digest();
  const actual = Buffer.from(mac, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new SigningError("invalid_view", 400);
  let view: Viewed;
  try { view = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Viewed; } catch { throw new SigningError("invalid_view", 400); }
  if (view.userId !== userId || view.kind !== kind || view.id !== id || typeof view.body !== "string") throw new SigningError("invalid_view", 400);
  return view;
}

function assertDraftPreviewPublication(form: FormData, userId: string, draft: { id: number; version: number; kind: string; title: string | null; body: string; lang: string; asksStance: boolean }) {
  const view = readView(form, userId, "draft", draft.id);
  const raw = readEntryForm(form);
  if (draft.kind !== "topic" || view?.version !== String(draft.version) || formString(form, "version") !== view.version
    || view.body !== draft.body || view.title !== titleOrNull(draft.title) || view.lang !== draft.lang
    || raw.body !== normalizeNewlines(draft.body) || titleOrNull(raw.title) !== view.title || raw.lang !== view.lang || raw.asksStance !== draft.asksStance) {
    throw new SigningError("draft_conflict", 409);
  }
}

type Intent = { preview: SigningPreview; payload: string; payloadHash: string; formHash: string };
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
function routeOperation(path: string, form: FormData): { operation: SigningOperation; id: number | null } {
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
  if (path === "/settings" && intent === "sign-posts") return { operation: "change-signing-preference", id: null };
  if (path === "/settings/delete-account" && intent === "delete-account") return { operation: "delete-account", id: null };
  throw new SigningError("not_a_signed_operation", 400);
}

function signatureRequired(operation: SigningOperation, profile: { signPosts: boolean; passkeyOnly: boolean }): boolean {
  return operation === "change-signing-preference" || profile.signPosts || (operation === "remove-passkey" && profile.passkeyOnly);
}

export function signingPreferenceValue(form: FormData): boolean {
  const value = formString(form, "signPosts");
  if (value !== "" && value !== "1") throw new SigningError("invalid_payload", 400);
  return value === "1";
}

function assertSigningPreferenceOpen(signPosts: boolean, requested: boolean) {
  if (!signPosts && requested) throw new SigningError("signing_closed", 409);
}

async function loadIntent(tx: Tx, userId: string, pathname: string, form: FormData, mode?: "review" | "publication"): Promise<Intent> {
  const { operation, id } = routeOperation(pathname, form);
  if (villagesEnabled() && (operation === "create-topic" || operation === "publish-draft")) await lockVillageProfile(tx, userId);
  if (id !== null && (!Number.isSafeInteger(id) || id < 1)) throw new SigningError("invalid_target", 400);
  const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
  if (!profile) throw new SigningError("not_a_member");
  const raw = readEntryForm(form);
  let content: SigningContent = { title: titleOrNull(raw.title), body: raw.body, lang: raw.lang || defaultPostLang(profile as unknown as Profile) };
  let language: SigningPreview["language"] = null;
  let input: Record<string, unknown> = {};
  let viewed: Viewed | null = null;
  let current: SigningContent | null = null;
  let lastEditor: SigningPreview["lastEditor"] = null;
  let baseVersion: string | number | boolean | null = null;
  let village: PublicVillage | undefined;
  let confirmation: string | undefined;
  const target: SigningPreview["target"] = { threadId: null, parentId: null, entryId: null, draftId: null, altOf: null };
  if (operation === "create-topic" || operation === "create-reply") {
    const parentId = operation === "create-reply" ? readReplyParent(form) : undefined;
    if (parentId !== undefined && parentId !== null && (!Number.isSafeInteger(parentId) || parentId < 1)) throw new SigningError("parent_not_in_thread", 400);
    const pasted = (await applyPastedFrontmatter(raw, operation === "create-topic" ? "topic" : "reply", { defaultLang: defaultPostLang(profile as unknown as Profile), ...(id === null ? {} : { threadId: id }), parentId }));
    if (!pasted.ok) throw new SigningError(pasted.error, 400);
    language = pasted.language;
    content = { title: operation === "create-topic" ? publicTitle(pasted.input.title) : null, body: pasted.input.body, lang: pasted.input.lang };
    target.threadId = id;
    target.parentId = pasted.parentId ?? null;
    target.altOf = operation === "create-topic" ? pasted.input.altOf : null;
    input = { ...content, asksStance: operation === "create-topic" ? pasted.input.asksStance : false, stanceTag: operation === "create-reply" ? pasted.input.stanceTag : null, aiAssistance: pasted.input.aiAssistance };
    if (villagesEnabled() && operation === "create-topic") {
      const destination = await villageForTopic(tx, userId, pasted.input.village);
      if (!destination) throw new SigningError("village_required", 400);
      if ((raw.villageDisplayed ?? "").trim().toLowerCase() !== destination.slug) throw new SigningError("village_changed", 409, destination.slug ?? undefined);
      target.villageId = destination.id;
      const { id: _id, ...publicDestination } = destination;
      village = publicDestination;
      input.village = destination.slug;
    }
  } else if (operation === "publish-draft") {
    const [draft] = await lockPublicationDraft(tx, userId, id!);
    if (!draft) throw new SigningError("not_found", 404);
    if (pathname.endsWith("/preview")) {
      if (mode === "publication") await assertDraftPreviewForm(tx, form, userId, draft, raw);
      else assertDraftPreviewPublication(form, userId, draft);
    }
    const confirm = mode === "review" && !profile.signPosts && needsDraftConfirmation(draft);
    if (confirm && Number(formString(form, "version")) !== draft.version) throw new SigningError("draft_conflict", 409);
    const publication = await draftPublication(tx, draft, raw, { tx, confirm });
    assertDraftVillageDisplay(publication, raw);
    Object.assign(target, publication.target);
    baseVersion = publication.baseVersion;
    current = contentOf(draft);
    viewed = readView(form, userId, "draft", draft.id);
    content = publication.content;
    input = { ...publication.input, kind: draft.kind };
    village = publication.village;
    if (confirm) confirmation = draftConfirmation(userId, publication);
    lastEditor = { id: draft.clientId ?? (draft.via === "api" ? `token:${draft.tokenId ?? "deleted"}` : null), name: draft.clientName, uri: draft.clientUri, at: (draft.clientUpdatedAt ?? (draft.via === "api" ? draft.updatedAt : null))?.toISOString() ?? null };
  } else if (operation === "edit-topic" || operation === "edit-reply") {
    await lockReferenceTopics(tx, { entryId: id!, body: raw.body });
    const [entry] = await tx.select().from(entries).where(eq(entries.id, id!)).for("no key update");
    if (!entry || entry.deletedAt) throw new SigningError("not_found", 404);
    const [actor] = await tx.select({ id: user.id, email: user.email, name: user.name }).from(user).where(eq(user.id, userId));
    const editable = await getEditableEntry(tx, userId, id!, { kind: operation === "edit-topic" ? "topic" : "reply", viewer: await getViewer(tx, actor!) });
    if (!editable.ok) throw new SigningError(editable.error, editable.error === "not_found" ? 404 : 403);
    current = contentOf(entry);
    viewed = readView(form, userId, "entry", entry.id);
    baseVersion = canonicalSigningJson({ sourceHash: entry.sourceHash ?? sourceHash(entry.title, entry.body, entry.lang), lang: entry.lang, mentionRevision: entry.mentionRevision, stanceTag: entry.stanceTag, editedAt: entry.editedAt?.toISOString() ?? null });
    target.entryId = entry.id;
    target.threadId = entry.threadId ?? entry.id;
    target.parentId = entry.parentId;
    target.altOf = entry.altOf;
    content = { title: operation === "edit-topic" ? publicTitle(raw.title) : null, body: raw.body, lang: editable.entry.mode === "moderator-fix" ? entry.lang : raw.lang || entry.lang };
    input = { ...content, asksStance: entry.asksStance, aiAssistance: entry.aiAssistance, stanceTag: operation === "edit-reply" && !pathname.startsWith("/mcp/entry-edits/") ? raw.stanceTag : entry.stanceTag, note: formString(form, "note"), mode: editable.entry.mode };
  } else if (operation === "delete-account") {
    const posts = formString(form, "posts") || "keep";
    if (!["keep", "delete"].includes(posts) || formString(form, "confirmation") !== profile.handle) throw new SigningError("invalid_payload", 400);
    baseVersion = profile.handle;
    const owned = await tx.select({ id: villages.id, name: villages.name }).from(villageMembers).innerJoin(villages, eq(villages.id, villageMembers.villageId))
      .where(and(eq(villageMembers.userId, userId), eq(villageMembers.role, "owner"), isNull(villages.endedAt), isNull(villages.language))).orderBy(villages.id);
    const choices = await Promise.all(owned.map(async village => {
      const choice = formString(form, `village:${village.id}`);
      const [member] = choice.startsWith("member:") ? await tx.select({ handle: profiles.handle }).from(villageMembers).innerJoin(profiles, eq(profiles.userId, villageMembers.userId)).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, choice.slice(7)))) : [];
      return `${village.name}: ${member ? m.account_delete_transfer_member({ handle: member.handle }) : choice === "end" ? m.account_delete_end() : m.account_delete_transfer()}`;
    }));
    content = { title: m.account_delete_title(), body: `${posts === "delete" ? m.account_delete_remove() : m.account_delete_keep()}\n\n${m.account_delete_chat_help()}${choices.length ? `\n\n${choices.join("\n")}` : ""}`, lang: null };
    input = { posts, confirmation: profile.handle, villages: Object.fromEntries([...form].filter(([key]) => key.startsWith("village:")).map(([key, value]) => [key, String(value)])) };
  } else if (operation === "change-display-name") {
    const names = parseDisplayNames(formString(form, "displayName"), formString(form, "displayNameLatin"));
    if (!names) throw new SigningError("invalid_display_name", 400);
    baseVersion = canonicalSigningJson({ displayName: profile.displayName, displayNameLatin: profile.displayNameLatin });
    const display = (names: { displayName: string | null; displayNameLatin: string | null }): SigningContent => ({ title: null, body: `${m.display_name_native()}: ${names.displayName ?? ""}\n${m.display_name_latin()}: ${names.displayNameLatin ?? ""}`, lang: null });
    current = display(profile);
    content = display(names);
    input = names;
  } else if (operation === "change-handle") {
    baseVersion = profile.handle;
    current = { title: null, body: profile.handle, lang: null };
    content = { title: null, body: formString(form, "handle").trim().normalize("NFKC").toLowerCase(), lang: null };
    input = { handle: content.body };
  } else if (operation === "change-signing-preference") {
    const signPosts = signingPreferenceValue(form);
    assertSigningPreferenceOpen(profile.signPosts, signPosts);
    baseVersion = profile.signPosts;
    const display = (value: boolean): SigningContent => ({ title: null, body: `${m.settings_sign_posts_label()}: ${value ? m.settings_sign_posts_on() : m.settings_sign_posts_off()}`, lang: null });
    current = display(profile.signPosts);
    content = display(signPosts);
    input = { signPosts, previousSignPosts: profile.signPosts };
  } else {
    const keys = await tx.select().from(passkey).where(eq(passkey.userId, userId));
    const key = keys.find(k => k.id === formString(form, "passkeyId"));
    if (!key) throw new SigningError("not_found", 404);
    if (keys.length <= 1 && (profile.signPosts || profile.passkeyOnly)) throw new SigningError("last_passkey", 409);
    baseVersion = canonicalSigningJson(keys.map(k => k.credentialID).sort());
    content = { title: key.name, body: key.name ?? "", lang: null };
    input = { passkeyId: key.id, credentialId: key.credentialID };
  }
  if (["create-topic", "create-reply", "edit-topic", "edit-reply", "publish-draft"].includes(operation)) {
    const bodyError = await checkBodyBudget(content.body, userId);
    if (bodyError) throw new SigningError(bodyError, 400);
  }
  if ((operation === "publish-draft" || operation === "edit-topic" || operation === "edit-reply") && content.lang) {
    if (content.lang === "other") content = { ...content, lang: (await resolvePostLanguage(content.body, content.lang, content.lang)).lang };
    const detected = await detectSourceLanguage(content.body, content.lang);
    language = { source: "explicit", detected: detected?.lang ?? null, ...(detected?.lang === "other" ? { langCode: detected.langCode } : {}) };
  }
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
  const targetContext = { thread: destinationOk ? targetContent(destinationId) : null, parent: parentOk ? targetContent(target.parentId) : null };
  const formHash = signingFormHash(form);
  const payload = canonicalSigningJson({ version: 1, actor: userId, operation, pathname, target, baseVersion, input, formHash });
  const payloadHash = sha256(payload);
  const keys = await tx.select({ id: passkey.id }).from(passkey).where(eq(passkey.userId, userId));
  return { payload, payloadHash, formHash, preview: { operation, payloadHash, content, language, viewed: viewed ? { title: viewed.title, body: viewed.body, lang: viewed.lang } : null, current, target, lastEditor, targetContext, enrolled: keys.length > 0, signatureRequired: signatureRequired(operation, profile), ...(village ? { village } : {}), ...(confirmation ? { confirmation } : {}) } };
}

export async function previewSignedWrite(db: Db, userId: string, pathname: string, form: FormData): Promise<SigningPreview> {
  return db.transaction(async tx => { await lockSigningMember(tx, userId); return (await loadIntent(tx, userId, pathname, form, "review")).preview; });
}

export function boundChallenge(payloadHash: string): string {
  return Buffer.from(`tomola:v1:${randomBytes(32).toString("hex")}:${payloadHash}`, "utf8").toString("base64url");
}
export function transportsOf(value: string | null): AuthenticatorTransportFuture[] | undefined {
  return value ? value.split(",") as AuthenticatorTransportFuture[] : undefined;
}
export async function issueSignedWrite(db: Db, userId: string, pathname: string, form: FormData, expectedPreviewHash: string, now = new Date()): Promise<SigningOptions> {
  return db.transaction(async tx => {
    await lockSigningMember(tx, userId);
    const intent = await loadIntent(tx, userId, pathname, form);
    if (!intent.preview.signatureRequired) throw new SigningError("signature_not_required", 409);
    if (intent.payloadHash !== expectedPreviewHash) throw new SigningError("approval_changed", 409);
    const keys = await tx.select().from(passkey).where(eq(passkey.userId, userId));
    if (!keys.length) throw new SigningError("passkey_required", 409);
    const challenge = boundChallenge(intent.payloadHash);
    const options = await generateAuthenticationOptions({ rpID: signingSite().rpId, challenge: Buffer.from(challenge, "base64url"), timeout: SIGNING_TTL_MS, userVerification: "required", allowCredentials: keys.map(k => ({ id: k.credentialID, transports: transportsOf(k.transports) })) });
    await tx.insert(signingChallenges).values({ challenge, userId, operation: intent.preview.operation, payload: intent.payload, payloadHash: intent.payloadHash, formHash: intent.formHash, createdAt: now, expiresAt: new Date(now.getTime() + SIGNING_TTL_MS) });
    return { challenge, options };
  });
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
// Runs mutate inside a transaction, including when signing is disabled. With a transactional db, this boundary is a savepoint.
// When mutate throws, signing state and the mutation roll back together and the exception propagates before conversion to
// an HTTP response. When mutate returns { ok: false }, the boundary commits, so a consumed signing challenge stays consumed.
export async function withSignedWrite<T extends MutationResult>(db: Db, userId: string, request: Request, form: FormData, mutate: (tx: Tx) => Promise<T>, opts: { now?: Date } = {}): Promise<T> {
  try { return await prepareSignedEntryRender(db, userId, request, form, () => signedWriteInTransaction(db, userId, request, form, mutate, opts)); }
  catch (error) { if (error instanceof SigningError) throw signingErrorResponse(error); throw error; }
}
async function prepareSignedEntryRender<T>(db: Db, userId: string, request: Request, form: FormData, run: () => Promise<T>): Promise<T> {
  const path = new URL(request.url).pathname.replace(/\.data$/, "");
  const { operation, id } = routeOperation(path, form);
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

async function publishUnsignedDraft<T extends MutationResult>(
  tx: Tx, userId: string, id: number, fromPreview: boolean, form: FormData, mutate: (tx: Tx) => Promise<T>, now?: Date,
): Promise<T> {
  if (villagesEnabled()) await lockVillageProfile(tx, userId);
  const [draft] = await lockPublicationDraft(tx, userId, id);
  if (!draft) throw new SigningError("not_found", 404);
  const raw = readEntryForm(form);
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
  if (fromPreview) await assertDraftPreviewForm(tx, form, userId, draft, raw);
  const result = await mutate(tx);
  if (publication && result.ok) {
    const [entry] = result.id === undefined ? [] : await tx.select().from(entries).where(eq(entries.id, result.id));
    if (!entry || entry.authorId !== userId || entry.kind !== draft.kind) throw new SigningError("published_target_changed", 409);
    assertPublishedEntry(entry, publication);
  }
  return result;
}

async function signedWriteInTransaction<T extends MutationResult>(db: Db, userId: string, request: Request, form: FormData, mutate: (tx: Tx) => Promise<T>, opts: { now?: Date }): Promise<T> {
  return db.transaction(async tx => {
    await lockSigningMember(tx, userId);
    // React Router's hydrated submissions use the route's .data transport URL.
    const transportPath = new URL(request.url).pathname;
    const pathname = transportPath === "/_.data" ? "/" : transportPath.endsWith(".data") ? transportPath.slice(0, -5) : transportPath;
    const { operation, id } = routeOperation(pathname, form);
    const [profile] = await tx.select({ signPosts: profiles.signPosts, passkeyOnly: profiles.passkeyOnly }).from(profiles).where(eq(profiles.userId, userId));
    if (!profile) throw new SigningError("not_a_member");
    if (operation === "change-signing-preference" && !profile.signPosts) assertSigningPreferenceOpen(false, signingPreferenceValue(form));
    if (!signatureRequired(operation, profile)) {
      return operation === "publish-draft"
        ? publishUnsignedDraft(tx, userId, id!, pathname.endsWith("/preview"), form, mutate, opts.now)
        : mutate(tx);
    }
    const challenge = formString(form, SIGNATURE_CHALLENGE_FIELD);
    const assertionText = formString(form, SIGNATURE_ASSERTION_FIELD);
    if (!challenge || !assertionText) throw new SigningError("signature_required");
    let assertion: AuthenticationResponseJSON;
    try { assertion = JSON.parse(assertionText) as AuthenticationResponseJSON; } catch { throw new SigningError("invalid_signature"); }
    const [issued] = await tx.select().from(signingChallenges).where(and(eq(signingChallenges.challenge, challenge), eq(signingChallenges.userId, userId))).for("update");
    const now = opts.now ?? new Date();
    if (!issued || issued.usedAt) throw new SigningError("challenge_used_or_unknown");
    if (issued.expiresAt <= now) throw new SigningError("challenge_expired");
    const intent = await loadIntent(tx, userId, pathname, form, "publication");
    if (intent.payloadHash !== issued.payloadHash || intent.formHash !== issued.formHash || intent.preview.operation !== issued.operation) throw new SigningError("approval_changed", 409);
    const key = await verifySignedAssertion(tx, userId, challenge, assertion);
    await tx.update(signingChallenges).set({ usedAt: now }).where(eq(signingChallenges.challenge, challenge));
    const result = await mutate(tx);
    if (result.ok && intent.preview.operation !== "remove-passkey" && intent.preview.operation !== "delete-account") {
      const entryId = intent.preview.target.entryId ?? result.id ?? null;
      const [entry] = entryId === null ? [] : await tx.select().from(entries).where(eq(entries.id, entryId));
      const approved = JSON.parse(issued.payload) as ApprovedEntry;
      if (entry) {
        assertPublishedEntry(entry, approved);
      } else if (intent.preview.operation === "change-handle") {
        const [updated] = await tx.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.userId, userId));
        if (updated?.handle !== approved.input.handle) throw new SigningError("published_content_changed", 409);
      } else if (intent.preview.operation === "change-display-name") {
        const [updated] = await tx.select().from(profiles).where(eq(profiles.userId, userId));
        if (updated?.displayName !== approved.input.displayName || updated?.displayNameLatin !== approved.input.displayNameLatin) throw new SigningError("published_content_changed", 409);
      } else if (intent.preview.operation === "change-signing-preference") {
        const [updated] = await tx.select({ signPosts: profiles.signPosts, passkeyOnly: profiles.passkeyOnly }).from(profiles).where(eq(profiles.userId, userId));
        if (updated?.signPosts !== approved.input.signPosts) throw new SigningError("published_content_changed", 409);
      }
      await tx.insert(memberSignatures).values({ userId, entryId, sourceHash: entry?.sourceHash ?? null, operation: issued.operation, payload: issued.payload, payloadHash: issued.payloadHash, challenge, credentialId: key.credentialID, publicKey: key.publicKey, rpId: signingSite().rpId, origin: signingSite().origin, assertion: assertion as unknown as Record<string, unknown>, authenticatorData: assertion.response.authenticatorData, clientDataJson: assertion.response.clientDataJSON, signature: assertion.response.signature, createdAt: now });
    }
    return result;
  });
}
