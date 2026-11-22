import { lazy, Suspense, type ReactNode } from "react";
import { DialogClose, DialogContent, DialogTitle } from "~/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { SigningChanges, SigningLastEditor } from "~/components/signing-changes";
import { languageLabel } from "~/lib/language-label";
import { isLang, LANG_LABELS } from "~/lib/languages";
import type { SigningContent, SigningOperation, SigningPreview } from "~/lib/signing";
import { useEnabledLangs } from "~/lib/use-enabled-langs";
import { postingVillageName } from "~/lib/village-name";
import { m } from "~/paraglide/messages.js";

const SourceLanguageNotice = lazy(() => import("./source-language-notice"));

export default function SigningReview({ preview, fixedSigningContent, busy, canSign, feedback, changeLanguage, accept }: {
  preview: SigningPreview;
  fixedSigningContent?: boolean;
  busy: boolean;
  canSign: boolean;
  feedback: ReactNode;
  changeLanguage: (lang: string) => Promise<void>;
  accept: () => void;
}) {
  const enabled = useEnabledLangs();
  return <DialogContent showCloseButton={false} aria-label={m.signing_heading()} className="top-4 bottom-4 start-4 end-4 ms-auto me-auto flex h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl translate-x-0 rtl:translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded border p-0 sm:max-w-3xl">
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <DialogTitle className="text-xl font-semibold">{m.signing_heading()}</DialogTitle>
      <p>{preview.signatureRequired ? m.signing_intro() : m.confirm_ai_draft_intro()}</p>
      {preview.village && <div className="space-y-1" data-signing-village><p>{postingVillageName(preview.village, preview.village.slug?.slice(1) ?? null)}</p><p>{m.village_public_reach()}</p></div>}
      <SigningLastEditor editor={preview.lastEditor} />
      {preview.content.lang && <div className="flex min-w-0 flex-wrap items-center gap-2">
        <p>{(preview.language?.source === "detected" ? m.original_lang_detected : preview.language?.source === "default" ? m.original_lang_default : m.original_lang)({ lang: preview.content.lang === "other" ? languageLabel("other", preview.language?.langCode) : isLang(preview.content.lang) ? LANG_LABELS[preview.content.lang] : preview.content.lang })}</p>
        {!fixedSigningContent && ["create-topic", "create-reply", "publish-draft"].includes(preview.operation) && <Select value={enabled.some(lang => lang === preview.content.lang) ? preview.content.lang : "other"} items={[...enabled.map(lang => ({ value: lang, label: <span lang={lang}>{LANG_LABELS[lang]}</span> })), { value: "other", label: m.source_language_other() }]} disabled={busy} onValueChange={lang => { if (lang !== null) void changeLanguage(lang); }}>
          <SelectTrigger aria-label={m.field_lang()} className="max-w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{enabled.map(lang => <SelectItem key={lang} value={lang}><span lang={lang}>{LANG_LABELS[lang]}</span></SelectItem>)}<SelectItem value="other">{m.source_language_other()}</SelectItem></SelectContent>
        </Select>}
      </div>}
      {preview.content.lang && !enabled.some(lang => lang === preview.content.lang) && <Suspense fallback={null}><SourceLanguageNotice lang={preview.content.lang} langCode={preview.language?.langCode} /></Suspense>}
      {!fixedSigningContent && preview.language?.source === "explicit" && preview.language.detected && preview.language.detected !== preview.content.lang && ["create-topic", "create-reply", "publish-draft"].includes(preview.operation) && <div>
        <p>{m.original_lang_mismatch({ detected: languageLabel(preview.language.detected, preview.language.langCode) })}</p>
        <Button variant="outline" type="button" disabled={busy} onClick={() => void changeLanguage(preview.language!.detected!)}>{m.original_lang_change({ detected: languageLabel(preview.language.detected, preview.language.langCode) })}</Button>
      </div>}
      {preview.content.title && <h3 dir="auto" className="whitespace-pre-wrap font-semibold">{preview.content.title}</h3>}
      <pre dir="auto" className="whitespace-pre-wrap break-words rounded border p-3 font-sans">{preview.content.body}</pre>
      <SigningChanges preview={preview} />
      {preview.targetContext.thread && <SigningTarget content={preview.targetContext.thread} label={preview.target.threadId === null && preview.target.altOf !== null ? m.signing_target_alt() : m.signing_target_thread()} href={`/t/${preview.target.threadId ?? preview.target.altOf}`} />}
      {preview.targetContext.parent && <SigningTarget content={preview.targetContext.parent} label={m.signing_target_parent()} href={`/t/${preview.target.threadId}#c-${preview.target.parentId}`} />}
    </div>
    <div className="sticky bottom-0 shrink-0 space-y-2 border-t bg-popover p-4">
      {feedback}
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant={["remove-passkey", "delete-account"].includes(preview.operation) ? "destructive" : "default"} onClick={accept} disabled={busy || preview.signatureRequired && !canSign}>{preview.signatureRequired ? signingAcceptLabel(preview.operation) : m.confirm_publish()}</Button>
        <DialogClose render={<Button variant="outline" type="button" disabled={busy} />}>{m.cancel()}</DialogClose>
      </div>
    </div>
  </DialogContent>;
}

function signingAcceptLabel(operation: SigningOperation): string {
  if (operation === "create-topic") return m.signing_accept_post();
  if (operation === "create-reply") return m.signing_accept_reply();
  if (operation === "publish-draft") return m.signing_accept_publish();
  if (operation === "remove-passkey" || operation === "delete-account") return m.signing_accept_remove();
  return m.signing_accept_save();
}

function SigningTarget({ content, label, href }: { content: SigningContent; label: string; href: string }) {
  const line = (content.title || content.body).split("\n").find((part) => part.trim()) ?? "";
  return <details className="rounded border p-3">
    <summary className="min-w-0 cursor-pointer">
      <span className="inline-flex max-w-full gap-2 align-middle">
      <span className="shrink-0 font-semibold">{label}</span><span dir="auto" className="truncate">{line}</span></span>
    </summary>
    <div className="mt-2 space-y-2">
      {content.title && <p dir="auto" className="whitespace-pre-wrap font-semibold">{content.title}</p>}
      <pre dir="auto" className="whitespace-pre-wrap break-words font-sans">{content.body}</pre>
      <a href={href} target="_blank" rel="noreferrer" className="underline">{m.signing_target_open()}</a>
    </div>
  </details>;
}
