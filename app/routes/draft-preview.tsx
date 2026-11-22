import { and, eq } from "drizzle-orm";
import { data, Link, type ShouldRevalidateFunctionArgs } from "react-router";
import { useEffect, useState } from "react";
import type { Route } from "./+types/draft-preview";
import { ArticleByline, ArticleSignature, ArticleVillageLink } from "~/components/article-byline";
import { RouteError } from "~/components/route-error";
import { SendButton, EntryForm } from "~/components/entry-form";
import { SigningChanges, SigningLastEditor } from "~/components/signing-changes";
import { StanceChoices } from "~/components/stance-panel";
import { TranslatedEntry } from "~/components/translated-entry";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { drafts } from "~/lib/db/schema";
import { villageReaderFor } from "~/lib/display-lang.server";
import { draftAction } from "~/lib/draft-action.server";
import { clearPreviousDraftView, previousDraftView } from "~/lib/draft-preview-submit";
import { entryErrorMessage } from "~/lib/entry-error-message";
import { renderEntryHtml } from "~/lib/entries.server";
import type { SourceLang } from "~/lib/languages";
import { headlineFromBody } from "~/lib/headline.server";
import { withMarkdownPersistedRead } from "~/lib/markdown-budget.server";
import { getWriter } from "~/lib/members.server";
import { resolveMentionTargets } from "~/lib/mentions.server";
import { parseIdOrNull } from "~/lib/params.server";
import { readingVersions } from "~/lib/reading.server";
import { DRAFT_CONFIRMATION_FIELD, isDraftConfirmationError, needsDraftConfirmation } from "~/lib/signing";
import { confirmationForDraftPreview, signingViewToken } from "~/lib/signing.server";
import { titleOrNull } from "~/lib/text";
import { postingVillageName } from "~/lib/village-name";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { postingVillages, villageSlug } from "~/lib/villages.server";
import { m } from "~/paraglide/messages.js";

export function headers() {
  return { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError error={error} showSite={false} />;
}

const original = { shown: "original", pending: false, translation: null } as const;

export async function loader({ request, params }: Route.LoaderArgs) {
  const { user, profile, db } = await requireMember(request);
  const id = parseIdOrNull(params.id);
  const [row] = id === null ? [] : await db.select().from(drafts)
    .where(and(eq(drafts.id, id), eq(drafts.authorId, user.id), eq(drafts.kind, "topic")));
  if (!row) throw data("Not found", { status: 404, headers: headers() });
  const { body, version, asksStance } = row;
  const title = titleOrNull(row.title);
  const lang = row.lang as SourceLang;
  const { html, headline } = await withMarkdownPersistedRead(async () => {
    const mentions = await resolveMentionTargets(db, body);
    return { ...(await renderEntryHtml("topic", row.id, body, lang, mentions)), headline: title ? "" : await headlineFromBody(body) };
  });
  const posting = villagesEnabled() ? await postingVillages(db, user.id, await villageSlug(db, row.villageId),
    { repair: false, reader: villageReaderFor(request, profile) }) : null;
  const village = posting?.choices.find(choice => choice.slug === posting.selected) ?? null;
  const author = { handle: profile.handle, name: profile.displayName, latin: profile.displayNameLatin };
  const content = { title, body, lang };
  const requiresReview = needsDraftConfirmation(row);
  const confirmation = requiresReview && (await getWriter(db, user.id, { profile })).ok
    ? await confirmationForDraftPreview(db, row, posting)
    : undefined;
  const signingView = signingViewToken({ userId: user.id, kind: "draft", id: row.id, version: String(version), ...content });
  const editor = {
    id: row.clientId ?? (row.via === "api" ? `token:${row.tokenId ?? "deleted"}` : null),
    name: row.clientName,
    uri: row.clientUri,
    at: (row.clientUpdatedAt ?? (row.via === "api" ? row.updatedAt : null))?.toISOString() ?? null,
  };
  return data({
    id: row.id, version, asksStance, content, headline, html, author, village,
    reading: readingVersions(html, lang, original),
    posting: posting && { selected: posting.selected, explicit: posting.explicit },
    signingView, editor, requiresReview, confirmation,
    baseline: row.aiBaseline ? { ...row.aiBaseline, lang } : null,
    tabTitle: m.draft_preview_title({ title: title ?? (headline || m.draft_untitled()) }),
  }, { headers: headers() });
}

export async function action(args: Route.ActionArgs) {
  assertSameOrigin(args.request);
  return draftAction(args, await requireWriter(args.request), true);
}

export function shouldRevalidate({ actionResult, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return actionResult?.error ? false : defaultShouldRevalidate;
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.tabTitle ?? m.draft_title() }, { name: "robots", content: "noindex" }];
}

export default function DraftPreview({ loaderData, actionData }: Route.ComponentProps) {
  const { id, content, headline, html, version, asksStance, reading, author, village, posting, signingView, editor, baseline, requiresReview, confirmation } = loaderData;
  const [prior] = useState(() => ({ id, version, content: previousDraftView(id) }));
  useEffect(() => { clearPreviousDraftView(id); }, [id]);
  const viewed = prior.id === id && prior.version === version && prior.content?.lang === content.lang ? prior.content : baseline;
  const editPath = `/drafts/${id}`;
  const place = village ? postingVillageName(village, author.handle) : m.village_target_unavailable();
  const error = actionData?.error;
  const conflictMessage = m.draft_preview_conflict();
  const stale = error === "draft_conflict" || error === "not_found" || error === "village_changed" || actionData?.saved;
  return <>
    <EntryForm method="post" action={`${editPath}/preview`} confirmAiDraft={requiresReview} fixedContent draftConflictMessage={conflictMessage}
      className="sticky top-0 z-10 mb-6">
      <input type="hidden" name="version" value={version} />
      <input type="hidden" name="title" value={content.title ?? ""} />
      <input type="hidden" name="body" value={content.body} />
      <input type="hidden" name="lang" value={content.lang} />
      {asksStance && <input type="hidden" name="asksStance" value="1" />}
      <input type="hidden" name="signingView" value={signingView} />
      {confirmation && <input type="hidden" name={DRAFT_CONFIRMATION_FIELD} value={confirmation} />}
      {posting && <>
        <input type="hidden" name="village" value={posting.explicit ? posting.selected : ""} />
        <input type="hidden" name="villageExplicit" value={posting.explicit ? "1" : "0"} />
        <input type="hidden" name="villageDisplayed" value={posting.selected} />
      </>}
      <aside className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded border border-notice-border bg-notice-soft p-3 text-notice-foreground" aria-label={m.draft_preview_banner()}>
        <div>
          <p className="font-semibold">{m.draft_preview_banner()}</p>
          {posting && <p className="ui-meta">{m.draft_preview_destination({ place })}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={editPath} className={buttonVariants({ variant: "outline" })}>{m.draft_preview_back()}</Link>
          <SendButton intent="publish" disabled={stale || !content.body.trim() || posting !== null && !village}>{m.draft_preview_publish()}</SendButton>
        </div>
      </aside>
    </EntryForm>
    <main className="reading-column reading-topic space-y-6">
      {error && <p role="alert" className="text-destructive">{error === "draft_conflict" ? conflictMessage : error === "not_found" ? m.ai_write_gone() : entryErrorMessage(error)}</p>}
      {isDraftConfirmationError(error) && <noscript><a className="underline" href={`${editPath}/preview`}>{m.draft_confirmation_reload()}</a></noscript>}
      {(editor.id || requiresReview && viewed) && <div className="space-y-2 ui-help">
        <SigningLastEditor editor={editor} />
        <SigningChanges preview={{ viewed, current: null, content }} />
      </div>}
      <article id={`p-${id}`} className="space-y-2">
        <div className="reading-article-content space-y-2">
          <TranslatedEntry id={id} kind="topic" {...content} headline={headline} html={html} reading={reading} display={original}
            toolsBefore={asksStance && <Badge variant="secondary" className="bg-info text-info-foreground">{m.question_badge()}</Badge>}
            meta={<ArticleByline {...author} details={<>
              <ArticleVillageLink village={village} />
              <span>{m.draft_preview_unpublished()}</span>
            </>} />}
            footer={() => <ArticleSignature handle={author.handle} name={author.name} latin={author.latin} />}
          />
        </div>
      </article>
      {asksStance && <section id="stance" className="space-y-2 rounded border p-3">
        <h2 className="text-lg font-semibold">{m.stance_title()}</h2>
        <div role="group" aria-label={m.stance_title()} className="flex flex-wrap items-center gap-2"><StanceChoices disabled /></div>
      </section>}
      {village && village.kind !== "personal" && !village.language && <section data-article-end="" className="space-y-3">
        <div data-article-details="" className="relative flex flex-wrap items-center gap-x-4 gap-y-2 ui-meta text-muted-foreground">
          <ArticleVillageLink village={village} className="ui-meta underline" />
        </div>
      </section>}
    </main>
  </>;
}
