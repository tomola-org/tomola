import { data, redirect } from "react-router";
import { MarkdownBusyError } from "~/lib/markdown-budget.server";
import type { requireWriter } from "~/lib/auth/session.server";
import { deleteDraft, getDraft, publishDraft, removeDraftAltOf, updateDraft } from "~/lib/drafts.server";
import { replyLocation } from "~/lib/entries.server";
import { formString, readEntryForm } from "~/lib/entry-form.server";
import { parseId } from "~/lib/params.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { postedLocation } from "~/lib/posted-ui";
import { assertDraftPreviewPublication, SigningError, SigningFailureResponse, signingViewToken, withSignedWrite } from "~/lib/signing.server";
import { titleOrNull } from "~/lib/text";
import { villagesEnabled } from "~/lib/villages-enabled.server";

export async function draftAction({ request, params }: { request: Request; params: { id?: string } }, { user, db }: Awaited<ReturnType<typeof requireWriter>>, fromPreview = false) {

  const retained = request.clone();
  try {
    const id = parseId(params.id);
    const form = await request.formData();
    const intent = formString(form, "intent");

    if (fromPreview ? intent !== "publish" : !["save", "publish", "preview", "remove_alt", "delete"].includes(intent)) throw data("Bad request", { status: 400 });

    // Save screen contents before publication so failed validation does not lose edits. Do the same when removing the original-question link (remove_alt).
    // Topic drafts have the 「立場を聞く」 checkbox. Alternative-framing targets are fixed at creation and cannot change here; unchecking leaves alt_of present and prevents saving.
    // Reply drafts allow tag selection only for question replies. Non-question topics have no selector and no tag. Hide the selector if the topic becomes unreadable (hidden or deleted),
    // and do not interpret an omitted tag as removal: undefined means unchanged.
    // The form carries no ai_assistance: saving keeps the value the draft already has (set by frontmatter or the API), and publishing hands it on to the post.
    const { title, body, lang, asksStance, stanceTag, village, villageExplicit, villageDisplayed } = readEntryForm(form);
    const draft = await getDraft(db, user.id, id);
    const expectedVersion = Number(formString(form, "version"));
    const versionOptions = { returnVersion: true, expectedVersion };
    const proof = (version: number) => signingViewToken({ userId: user.id, kind: "draft", id, version: String(version), title: draft?.kind === "topic" ? titleOrNull(title) : null, body, lang });
    async function result(error: string | null, saved = false, version?: number, altRemoved = false, status = error ? 400 : 200, resolvedVillage?: string) {
      const latest = !fromPreview && error === "draft_conflict" ? await getDraft(db, user.id, id) : null;
      const latestView = latest ? signingViewToken({ userId: user.id, kind: "draft", id, version: String(latest.version), title: latest.title, body: latest.body, lang: latest.lang }) : null;
      // Echo unsaved input, using the new basis whenever this request saved before publication was refused.
      const target = resolvedVillage ?? village;
      const values = error && intent !== "delete" ? { title, body, lang, asksStance, version: version !== undefined ? String(version) : formString(form, "version"), signingView: version !== undefined ? proof(version) : formString(form, "signingView"), ...(villagesEnabled() ? { village: target } : {}) } : null;
      return data({ error, saved, altRemoved, previewFailed: intent === "preview", version, signingView: version === undefined ? undefined : proof(version), latest: latest ? { draft: latest, signingView: latestView! } : null, values, ...(villagesEnabled() && draft?.kind === "topic" ? { village: target ?? draft.village ?? null } : {}) }, { status, headers: { "Cache-Control": "private, no-store" } });
    }
    if (!draft) {
      if (form.has("version")) return result("not_found", false, undefined, false, 404);
      throw data("Not found", { status: 404 });
    }
    if (intent === "delete") {
      const version = draft.via === "api" || form.has("version") ? expectedVersion : undefined;
      if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > 2_147_483_647)) return result("draft_conflict", false, undefined, false, 409);
      if (!(await deleteDraft(db, user.id, id, version))) {
        const exists = await getDraft(db, user.id, id);
        return result(exists ? "draft_conflict" : "not_found", false, undefined, false, exists ? 409 : 404);
      }
      throw redirect("/drafts");
    }
    const input = draft.kind === "topic" ? { title, body, lang, asksStance, ...(villagesEnabled() ? { village: villageExplicit === false ? undefined : village } : {}) } : { title, body, lang, stanceTag: draft.threadAsksStance ? stanceTag : undefined };
    if (intent === "preview") {
      if (formString(form, "ownerId") !== user.id || draft.kind !== "topic" || (!title.trim() && !body.trim())) return result("invalid_draft");
      const saved = await updateDraft(db, user.id, id, { ...input, ...(villagesEnabled() && villageExplicit === false ? { village: null } : {}) }, { ...versionOptions, preview: true, skipUnchanged: true });
      if (!saved.ok) return result(saved.error, false, undefined, false, saved.error === "draft_conflict" ? 409 : saved.error === "not_found" ? 404 : 400);
      throw redirect(`/drafts/${id}/preview`);
    }
    if (intent === "publish") {
      if (fromPreview) {
        if (draft.kind !== "topic" || draft.version !== expectedVersion) return result("draft_conflict", false, undefined, false, 409);
        try { assertDraftPreviewPublication(form, user.id, draft); }
        catch (error) {
          if (error instanceof SigningError) return result(error.code, false, undefined, false, error.status);
          throw error;
        }
        if (villagesEnabled() && (villageExplicit !== Boolean(draft.village) || village !== (draft.village ?? ""))) return result("draft_conflict", false, undefined, false, 409);
      }
      const rate = await hitMemberLimit(db, draft.kind === "topic" ? "topic" : "reply", user.id);
      if (!rate.allowed) {
        const refused = await result("rate_limited", false, undefined, false, 429);
        return data(refused.data, { status: 429, headers: rateLimitHeaders(rate) });
      }
      let savedVersion: number | undefined;
      let didSave = false;
      let res;
      try {
        res = await withSignedWrite(db, user.id, request, form, async tx => {
          // The conditional update is inside the signed transaction, before creating any post.
          const saved = await updateDraft(tx, user.id, id, input, versionOptions);
          if (!saved.ok) return saved;
          didSave = true;
          savedVersion = saved.version;
          return villagesEnabled() ? publishDraft(tx, user.id, id, { villageDisplayed: villageDisplayed ?? "" }) : publishDraft(tx, user.id, id);
        });
      } catch (error) {
        if (error instanceof SigningFailureResponse) return result(error.code, false, undefined, false, error.status, error.village);
        if (error instanceof Response && error.status === 409) return result("draft_conflict", false, undefined, false, 409);
        throw error;
      }
      if (res.ok && "id" in res) throw redirect(postedLocation(res.kind === "topic" ? `/t/${res.id}` : await replyLocation(db, res.threadId, res.id), res.id, res.kind === "reply" && res.followed));
      const error = res.ok ? null : res.error;
      return result(error, didSave, savedVersion, false, error === "draft_conflict" ? 409 : error === "not_found" ? 404 : 400, !res.ok && "village" in res ? res.village : undefined);
    }
    const saved = await updateDraft(db, user.id, id, input, versionOptions);
    if (!saved.ok) {
      return result(saved.error, false, undefined, false, saved.error === "draft_conflict" ? 409 : saved.error === "not_found" ? 404 : 400);
    }
    if (intent === "remove_alt") {
      const removed = await removeDraftAltOf(db, user.id, id, { returnVersion: true, expectedVersion: saved.version });
      if (!removed.ok) return result(removed.error, true, saved.version, false, removed.error === "draft_conflict" ? 409 : 400);
      return result(null, true, removed.version ?? saved.version, true);
    }
    return result(null, true, saved.version);
  }
  catch (error) {
    if (!(error instanceof MarkdownBusyError) && !(error instanceof SigningFailureResponse)) throw error;
    const form = await retained.formData();
    const raw = readEntryForm(form);
    const values = { title: raw.title, body: raw.body, lang: raw.lang, asksStance: raw.asksStance, version: formString(form, "version"), signingView: formString(form, "signingView"), ...(villagesEnabled() ? { village: error instanceof SigningFailureResponse ? error.village ?? raw.village : raw.village } : {}) };
    return data({ error: error instanceof SigningFailureResponse ? error.code : "busy", saved: false, altRemoved: false, previewFailed: formString(form, "intent") === "preview", version: undefined, signingView: undefined, latest: null, values }, { status: error instanceof SigningFailureResponse ? error.status : 503, headers: error instanceof SigningFailureResponse ? { "Cache-Control": "private, no-store" } : { "Retry-After": "1" } });
  }

}
