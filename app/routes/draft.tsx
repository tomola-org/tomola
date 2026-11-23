import { submitDraftPreview } from "~/lib/draft-preview-submit";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { PersistentDetails } from "~/components/persistent-details";
import { Button } from "~/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { data, Form, Link, useLocation, type ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/draft";
import { entryErrorMessage } from "~/components/entry-fields";
import { StanceTagChips } from "~/components/stance-tag";
import { TopicFields } from "~/components/topic-fields";
import { isVillageTargetError } from "~/components/village-target";
import { LongFormBody } from "~/components/long-form-body";
import { draftAction } from "~/lib/draft-action.server";
import { DraftPreviewButton } from "~/components/draft-preview-button";
import { DraftAutosave } from "~/components/draft-autosave-lazy";
import { ReplyFields } from "~/components/reply-fields";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { getDraft } from "~/lib/drafts.server";
import { parseId } from "~/lib/params.server";
import { m } from "~/paraglide/messages.js";
import { signingViewToken } from "~/lib/signing.server";
import { isDraftConfirmationError } from "~/lib/signing";
import { isStanceTag } from "~/lib/stances";
import { EntryForm, SendButton } from "~/components/entry-form";
import { AiEditorTools } from "~/components/ai-editor-tools";
import { titleOrNull } from "~/lib/text";
import { orBlank } from "~/lib/local-draft";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { villageReaderFor } from "~/lib/display-lang.server";
import { postingVillages } from "~/lib/villages.server";
import { draftMdMiddleware } from "~/lib/md/draft.server";
import { draftRecoveryToken } from "~/lib/draft-recovery.server";
export const middleware: Route.MiddlewareFunction[] = [draftMdMiddleware];

// Open only the member's own drafts (404 for others). The draft editor uses the same publication action as the article preview.
// Publish only through same-origin POSTs from browser sessions. Tokens cannot publish: a token is not a session cookie,
// so it cannot pass requireMember. This screen is also where a member approves drafts submitted through the API.
// Check same-origin here in addition to React Router's built-in check: approval is the sole gate where a person can stop AI writes.
async function loaderImplementation({ request, params }: Route.LoaderArgs) {
  const { user, db, profile } = await requireMember(request);
  const draft = await getDraft(db, user.id, parseId(params.id));
  if (!draft) throw data("Not found", { status: 404 });
  return { ownerId: user.id, connectDraftLabel: m.connect_draft_link(), draft, recoveryToken: await draftRecoveryToken(db, user.id, draft), signingView: signingViewToken({ userId: user.id, kind: "draft", id: draft.id, version: String(draft.version), title: draft.title, body: draft.body, lang: draft.lang }), ...(villagesEnabled() && draft.kind === "topic" ? { posting: await postingVillages(db, user.id, draft.village, { reader: villageReaderFor(request, profile) }) } : {}) };
}

export async function action(args: Route.ActionArgs) {
  assertSameOrigin(args.request);
  return draftAction(args, await requireWriter(args.request));
}

export function clientAction({ request, serverAction }: Route.ClientActionArgs) {
  return submitDraftPreview(request, serverAction, { error: "busy", previewFailed: true, values: null, saved: false, altRemoved: false, version: undefined, signingView: undefined, latest: null });
}

export function shouldRevalidate({ actionResult, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  // Keep this editor and its pasted candidate even if the saved draft is now gone.
  if (actionResult?.previewFailed || actionResult?.error === "draft_conflict" || actionResult?.error === "not_found" || isDraftConfirmationError(actionResult?.error)) return false;
  return defaultShouldRevalidate;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.draft_title() }];
}

export const handle = { writing: true };


export default function DraftPage(props: Route.ComponentProps) {
  // The state of the form belongs to one draft: moving from one draft to another on the same screen starts the form again from that draft.
  return <DraftForm key={props.loaderData.draft.id} {...props} />;
}

function DraftForm({ loaderData, actionData }: Route.ComponentProps) {
  const originalDraft = useRef(loaderData.draft);
  const submitted = actionData?.values;
  const [draft, setDraft] = useState(() => {
    const stanceTag = submitted?.stanceTag;
    return submitted ? { ...loaderData.draft, title: titleOrNull(submitted.title), body: submitted.body, asksStance: submitted.asksStance,
      ...(stanceTag === null || isStanceTag(stanceTag) ? { stanceTag } : {}),
    } : loaderData.draft;
  });
  const requiresReview = draft.requiresReview;
  const [version, setVersion] = useState(submitted ? Number(submitted.version) : draft.version);
  const [signingView, setSigningView] = useState(submitted ? submitted.signingView : loaderData.signingView);
  const [resolvedConflict, setResolvedConflict] = useState<typeof actionData>();
  const feedback = actionData === resolvedConflict ? undefined : actionData;
  const [editorRound, setEditorRound] = useState(0);
  const [candidate, setCandidate] = useState("");
  const [retained, setRetained] = useState<string | null>(null);
  const main = useRef<HTMLElement>(null);
  const lastAction = useRef(actionData);
  const browserDraft = draft.via === "web" && !requiresReview;
  // A first save from the new-topic screen comes here with ?saved=1: this screen says it was saved, and the mark is taken off the address a little later.
  const location = useLocation();
  const savedHere = useRef(new URLSearchParams(location.search).get("saved") === "1");
  useEffect(() => {
    if (!savedHere.current) return;
    const timer = setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete("saved");
      window.history.replaceState(window.history.state, "", url);
    }, 5000);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!actionData || lastAction.current === actionData) return;
    lastAction.current = actionData;
    if (actionData.saved && actionData.version !== undefined && actionData.signingView) {
      setVersion(actionData.version);
      setSigningView(actionData.signingView);
      if ("village" in actionData) setDraft(current => ({ ...current, village: actionData.village }));
    }
    if (actionData.altRemoved) setDraft(current => ({ ...current, altOf: null, altTitle: null }));
  }, [actionData]);
  const [asksStance, setAsksStance] = useState(draft.asksStance);
  const [intro, setIntro] = useState(false);
  const guardDraft = editorRound > 0 || draft.id !== loaderData.draft.id ? draft : originalDraft.current;
  const error = feedback?.error ?? undefined;
  const errorText = feedback?.error ? (feedback.error === "draft_conflict" ? m.ai_write_conflict() : feedback.error === "not_found" ? m.ai_write_gone() : entryErrorMessage(feedback.error, draft.kind)) : undefined;
  // What follows the writing surface: how the last save or publish went, the newer saved version when another screen saved first, and the buttons.
  const status = <>
    {(savedHere.current && !feedback || feedback?.saved && !feedback.error) && <p role="status" className="text-success-foreground">{feedback?.altRemoved ? m.draft_alt_removed() : m.draft_saved()}</p>}
    {feedback?.previewFailed && <p id="draft-error" role="alert" className="ui-help text-muted-foreground">{m.draft_autosave_failed()}</p>}
    {!feedback?.previewFailed && errorText && !(loaderData.posting && draft.kind === "topic" && isVillageTargetError(error)) && <p id="draft-error" role="alert" className="text-destructive">{errorText}</p>}
    {error === "confirmation_required" && <noscript><p>{draft.kind === "topic" ? m.draft_confirmation_use_preview() : m.draft_confirmation_reply_javascript()}</p></noscript>}
    {!feedback?.previewFailed && feedback?.latest && <div className="space-y-2 rounded border p-3">
      <a href={`/drafts/${draft.id}`} target="_blank" rel="noreferrer noopener" className="underline">{m.ai_write_latest()}</a>
      <details><summary>{m.ai_write_latest()}</summary>
        <p>{feedback.latest.draft.title}</p>
        <p>{feedback.latest.draft.lang}</p>
        <pre className="whitespace-pre-wrap break-words">{feedback.latest.draft.body}</pre>
      </details>
      <Button type="button" variant="outline" onClick={() => {
        const latest = feedback.latest!;
        setRetained(main.current?.querySelector<HTMLTextAreaElement>('textarea[name="body"]')?.value ?? "");
        setDraft(latest.draft); setVersion(latest.draft.version); setSigningView(latest.signingView);
        setAsksStance(latest.draft.asksStance); setEditorRound(round => round + 1);
        setResolvedConflict(actionData);
      }}>{m.ai_write_use_latest()}</Button>
    </div>}
  </>;
  const buttons = <>
    {/* AI drafts require content review. */}
    <SendButton intent="publish">{m.draft_publish()}</SendButton>
    {draft.kind === "topic" && <DraftPreviewButton />}
    <noscript><SendButton variant="outline" intent="save" formNoValidate>{m.save_draft()}</SendButton></noscript>
    {/* Only alternative framings with unreadable originals may unlink. Save screen contents before removing the link. */}
    {draft.kind === "topic" && draft.altOf !== null && draft.altTitle === null && (
      <SendButton variant="outline" intent="remove_alt" formNoValidate>{m.draft_alt_remove()}</SendButton>
    )}
  </>;
  const ai = browserDraft && <AiEditorTools ownerId={loaderData.ownerId} connectDraftLabel={loaderData.connectDraftLabel} kind={draft.kind} threadId={draft.threadId ?? undefined} parentId={draft.parentId} draft={{ id: draft.id, version }} onSaved={saved => { setVersion(saved.version); setSigningView(saved.signingView); }} candidate={candidate} onCandidateChange={setCandidate} />;
  return (
    <main ref={main} className="space-y-4">
      <h1 className="text-xl font-bold">{m.draft_title()}</h1>
      {draft.via === "api" && (
        <div className="space-y-2 rounded border border-notice-border bg-notice-soft p-2 ui-help">
          <p>
            {m.draft_via_api()}
            {draft.tokenName && <> {m.draft_via_api_token({ name: draft.tokenName })}</>}
          </p>
          {draft.rawFrontmatter && (
            <details>
              <summary className="cursor-pointer">{m.draft_raw_frontmatter()}</summary>
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-xs">{draft.rawFrontmatter}</pre>
            </details>
          )}
        </div>
      )}
      {draft.kind === "reply" && (
        <p className="ui-help text-muted-foreground">
          {draft.threadTitle ? (
            <Link to={`/t/${draft.threadId}`} className="underline">
              {m.draft_reply_to({ title: draft.threadTitle })}
            </Link>
          ) : (
            m.draft_thread_gone()
          )}
        </p>
      )}
      <EntryForm action={`/drafts/${draft.id}`} protectUnsaved="edit" unsavedInitialValues={{ title: guardDraft.title, body: guardDraft.body, lang: guardDraft.lang, asksStance: guardDraft.asksStance, stanceTag: guardDraft.stanceTag ?? "", village: guardDraft.village ?? loaderData.posting?.selected ?? "" }} key={editorRound} confirmAiDraft={requiresReview} method="post" className="space-y-3">
        {draft.kind === "topic" && <input type="hidden" name="ownerId" value={loaderData.ownerId} />}
        <input type="hidden" name="signingView" value={signingView} />
        {/* Approval fields must stay stable when lazy autosave connects during review. */}
        <input type="hidden" name="version" value={version} />
        {draft.kind === "topic" ? <TopicFields
          error={error} errorId="draft-error"
          BodyEditor={LongFormBody}
          autoLang={false}
          invalidatePreviewOnEdit={browserDraft}
          posting={loaderData.posting ? { data: loaderData.posting, selected: feedback?.values?.village ?? (editorRound > 0 ? draft.village : undefined) ?? loaderData.posting.selected, explicit: loaderData.posting.explicit, error: loaderData.posting.error ?? undefined } : undefined}
          keeper={{ owner: loaderData.ownerId, scope: `draft:${draft.id}`, startTitle: orBlank(guardDraft.title), startBody: guardDraft.body }}
          defaultLang={draft.lang}
          selectedLang={(editorRound === 0 ? submitted?.lang : undefined) || draft.lang}
          defaultTitle={orBlank(draft.title)}
          defaultBody={draft.body}
          asksStance={asksStance}
          onAsksStanceChange={setAsksStance}
          intro={intro}
          onIntroChange={setIntro}
          showIntro={false}
          altFixedNote={draft.altOf !== null ? <>
            {/* Alternative framing: the target is immutable and only shown. It must ask for stances, so the kind is fixed and submitted as a hidden field. */}
            <p>{draft.altTitle ? m.alt_of_label({ title: draft.altTitle }) : m.alt_of_origin_unreadable()}</p>
            {/* The original question is unreadable (hidden or deleted): explain why publication is blocked and provide the 「元の問いへのリンクを外す」 exit below. */}
            {draft.altTitle === null && <p role="status" className="rounded border border-notice-border bg-notice-soft p-2 ui-help text-notice-foreground">{m.draft_alt_origin_unreadable_help()}</p>}
          </> : undefined}
        >
          {status}
          <div className="flex flex-wrap items-center gap-3">{buttons}{ai}</div>
        </TopicFields> : <>
          <ReplyFields
            owner={loaderData.ownerId} threadId={draft.threadId ?? 0} keeper={{ scope: `draft:${draft.id}`, startBody: guardDraft.body }}
            error={error} errorId="draft-error" autoLang={false} invalidatePreviewOnEdit={browserDraft}
            defaultLang={draft.lang} selectedLang={(editorRound === 0 ? submitted?.lang : undefined) || draft.lang} defaultBody={draft.body}
            above={draft.threadAsksStance ? <StanceTagChips defaultValue={draft.stanceTag} /> : undefined}
            actions={buttons}
            aiTools={browserDraft ? { ownerId: loaderData.ownerId, connectDraftLabel: loaderData.connectDraftLabel, kind: draft.kind, threadId: draft.threadId ?? undefined, parentId: draft.parentId, draft: { id: draft.id, version }, onSaved: saved => { setVersion(saved.version); setSigningView(saved.signingView); }, candidate, onCandidateChange: setCandidate } : undefined}
          />
          {status}
        </>}
      <DraftAutosave owner={loaderData.ownerId} recoveryToken={loaderData.recoveryToken} scope={`draft:${draft.id}`} startTitle={orBlank(guardDraft.title)} startBody={guardDraft.body} draft={{ id: draft.id, version }} onSaved={saved => {
        setVersion(saved.version); setSigningView(saved.signingView);
        setResolvedConflict(actionData);
        if (saved.id !== draft.id) {
          setDraft(current => ({ ...current, id: saved.id, title: saved.title, body: saved.body, lang: saved.lang as typeof current.lang, asksStance: saved.asksStance, via: "web", tokenName: null, rawFrontmatter: null }));
          window.history.replaceState(window.history.state, "", `/drafts/${saved.id}`);
        }
      }} />
      </EntryForm>
      {retained !== null && <PersistentDetails open>
        <summary>{m.ai_write_retained()}</summary>
        <textarea aria-label={m.ai_write_retained()} readOnly value={retained} className="w-full rounded border p-2" rows={6} onFocus={e => e.currentTarget.select()} />
      </PersistentDetails>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Form
          action={`/drafts/${draft.id}`}
          method="post"
          onSubmit={(e) => {
            if (!window.confirm(m.draft_delete_confirm())) e.preventDefault();
            else window.dispatchEvent(new Event("tomola:discard-unsaved"));
          }}
        >
          <input type="hidden" name="intent" value="delete" />
          <input type="hidden" name="version" value={version} />
          <Button variant="destructive" type="submit">
            {m.draft_delete()}
          </Button>
        </Form>
        {/* The plain-text version of the draft is a quiet link at the foot, not a fold at the head. */}
        {loaderData.posting && <Link to={`/drafts/${draft.id}.md`} reloadDocument className="ui-meta underline">{m.village_draft_markdown()}</Link>}
      </div>
    </main>
  );
}


// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
