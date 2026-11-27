import { UnsavedFormGuard } from "~/components/unsaved-form-guard";
import { pathWithoutNoticeParams } from "~/lib/notice-params";
import { useContext, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FormLanguageChangeContext, FormVillageReviewContext } from "~/components/form-contexts";
import type { FormSubmitHandler, EntryFormControlsProps } from "~/components/entry-form-frame";
import { flushSync } from "react-dom";
import { Dialog } from "~/components/ui/dialog";
import { useNavigation, useSubmit } from "react-router";
import { DRAFT_CONFIRMATION_FIELD, type SigningPreview } from "~/lib/signing";
import { m } from "~/paraglide/messages.js";
import { readerLoginHref } from "~/lib/public-reading";

type Pending = { fields: [string, string][]; action: string; preview: SigningPreview; Review: typeof import("./draft-confirmation-review").default };
class ConfirmationRequestError extends Error {
  constructor(code: string, readonly village?: string, readonly explanation?: string) { super(code); }
}
async function requestConfirmation(body: unknown) {
  const response = await fetch("/signing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual", cache: "no-store" });
  if (response.status === 401 || response.type === "opaqueredirect") throw new ConfirmationRequestError("login_required");
  if (response.status >= 500 && !response.headers.get("Content-Type")?.includes("application/json")) throw new ConfirmationRequestError("network_failed");
  let result;
  try { result = await response.json(); }
  catch { throw new ConfirmationRequestError("network_failed"); }
  if (result?.error === "maintenance_readonly") throw new ConfirmationRequestError("maintenance_readonly", undefined, typeof result.message === "string" ? result.message : undefined);
  if (response.status >= 500) throw new ConfirmationRequestError("network_failed");
  if (!response.ok) throw new ConfirmationRequestError(typeof result?.error === "string" ? result.error : "confirmation_failed", typeof result?.village === "string" ? result.village : undefined);
  return result;
}
function confirmationFailureMessage(error: unknown, draftConflictMessage?: string): string {
  if (error instanceof ConfirmationRequestError && error.message === "maintenance_readonly") return error.explanation || m.maintenance_readonly();
  if (error instanceof ConfirmationRequestError && error.message === "login_required") return m.signing_login_required();
  if (error instanceof ConfirmationRequestError && error.message === "draft_conflict") return draftConflictMessage ?? m.ai_write_conflict();
  // POST /signing returns signing_closed (409) for retired challenge requests.
  if (error instanceof ConfirmationRequestError && error.message === "signing_closed") return m.draft_review_reload();
  if (error instanceof Error && error.message === "body_too_complex") return m.error_body_too_complex();
  if (error instanceof TypeError || error instanceof ConfirmationRequestError && error.message === "network_failed") return m.signing_network_failed();
  return m.draft_review_failed();
}
function ConfirmationFailure({ message }: { message: string }) {
  return <><p role="alert" className="text-destructive">{message}</p>{message === m.signing_login_required() && <a className="underline" href={readerLoginHref(pathWithoutNoticeParams(window.location.pathname, window.location.search, window.location.hash), "")} target="_blank" rel="noreferrer noopener">{m.login_title()}</a>}</>;
}
const pairsOf = (form: FormData) => [...form.entries()].map(([name, value]) => [name, String(value)] as [string, string]);

// Keep the accepted snapshot immutable. Ordinary writes and draft saves retain native form submission.
export default function EntryFormControls({ protectUnsaved, unsavedInitialValues, preserveUnsavedOnSamePath, confirmAiDraft = false, fixedContent, draftConflictMessage, action: formAction, form: element, bypass, review, setReady }: EntryFormControlsProps) {
  useEffect(() => { setReady(true); }, [setReady]);
  useImperativeHandle(review, () => event => { void reviewSubmission(event); });
  const routerSubmit = useSubmit();
  function allowSubmission() {
    bypass.current = true;
    setTimeout(() => { bypass.current = false; }, 0);
  }
  const submit: typeof routerSubmit = (target, options) => {
    allowSubmission();
    return routerSubmit(target, options).catch(error => { bypass.current = false; throw error; });
  };
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const navigation = useNavigation();
  useEffect(() => {
    if (!pending && !busy && navigation.state === "idle") element.current?.dispatchEvent(new Event("tomola:autosave-resume"));
  }, [pending, busy, navigation.state, element]);
  const [error, setError] = useState<string | null>(null);
  const submission = useRef<HTMLButtonElement | HTMLInputElement | null>(null);
  const changeFormLanguage = useContext(FormLanguageChangeContext);
  const reviewFormVillage = useContext(FormVillageReviewContext);
  function recoverVillage(failure: unknown, fields: [string, string][]): boolean {
    if (!(failure instanceof ConfirmationRequestError)) return false;
    const code = failure.message;
    if (code !== "village_required" && (code !== "village_changed" || !failure.village)) return false;
    setPending(null);
    if (!unchanged({ fields })) { setError(m.signing_changed()); return true; }
    reviewFormVillage?.current?.(failure.village, fields.find(([name]) => name === "body")?.[1] ?? "", code);
    setError(reviewFormVillage?.current ? null : code === "village_required" ? m.village_required() : m.village_changed());
    return true;
  }
  async function reviewSubmission(event: Parameters<FormSubmitHandler>[0]) {
    if (!confirmAiDraft) { allowSubmission(); return; }
    const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | HTMLInputElement | null;
    const form = new FormData(event.currentTarget, button);
    const intent = String(form.get("intent") ?? "");
    if (intent !== "publish") { allowSubmission(); return; }
    event.preventDefault();
    if (busy) return;
    submission.current = button;
    const fields = pairsOf(form);
    const action = new URL(typeof formAction === "string" ? formAction : window.location.href, window.location.href).pathname + (typeof formAction === "string" ? new URL(formAction, window.location.href).search : window.location.search);
    setBusy(true); setError(null);
    element.current?.dispatchEvent(new Event("tomola:village-review-reset"));
    try {
      const preview = await requestConfirmation({ intent: "preview", pathname: new URL(action, window.location.href).pathname, fields }) as SigningPreview;
      if (!preview.confirmation && !preview.lastEditor?.id) {
        await submit(form, { method: "post", action });
      } else {
        const { default: Review } = await import("./draft-confirmation-review");
        setPending({ fields, action, preview, Review });
      }
    } catch (error) {
      if (!recoverVillage(error, fields)) setError(confirmationFailureMessage(error, draftConflictMessage));
    }
    finally { setBusy(false); }
  }
  function unchanged(snapshot: Pick<Pending, "fields">): boolean {
    return element.current !== null && JSON.stringify(pairsOf(new FormData(element.current, submission.current))) === JSON.stringify(snapshot.fields);
  }
  async function accept() {
    if (!pending || busy) return;
    const snapshot = pending;
    if (!unchanged(snapshot)) { setPending(null); setError(m.signing_changed()); return; }
    setBusy(true); setError(null);
    try {
      const form = new FormData();
      for (const [name, value] of snapshot.fields) form.append(name, value);
      if (snapshot.preview.confirmation) form.set(DRAFT_CONFIRMATION_FIELD, snapshot.preview.confirmation);
      setPending(null);
      await submit(form, { method: "post", action: snapshot.action });
    } catch (failure) {
      if (recoverVillage(failure, snapshot.fields)) return;
      setError(confirmationFailureMessage(failure, draftConflictMessage));
    } finally { setBusy(false); }
  }
  async function changeLanguage(lang: string) {
    if (!pending || busy || !element.current) return;
    const snapshot = pending;
    if (!unchanged(snapshot)) { setPending(null); setError(m.signing_changed()); return; }
    if (!changeFormLanguage?.current) return;
    flushSync(() => changeFormLanguage?.current?.(lang));
    const fields = snapshot.fields.map(([name, value]) => [name, name === "lang" ? lang : value] as [string, string]);
    setBusy(true); setError(null);
    try {
      const preview = await requestConfirmation({ intent: "preview", pathname: new URL(snapshot.action, window.location.href).pathname, fields }) as SigningPreview;
      setPending({ ...snapshot, fields, preview });
    } catch (error) { if (!recoverVillage(error, fields)) { setPending(null); setError(confirmationFailureMessage(error)); } }
    finally { setBusy(false); }
  }
  return <>
    {protectUnsaved && <UnsavedFormGuard form={element} mode={protectUnsaved} bypass={bypass} initial={unsavedInitialValues} retainOnSamePath={preserveUnsavedOnSamePath} />}
    {!pending && error && <ConfirmationFailure message={error} />}
    <Dialog open={pending !== null} disablePointerDismissal onOpenChange={(open, details) => {
      if (open) return;
      if (busy) { details.cancel(); return; }
      setPending(null); setError(null);
    }}>
    {pending && <pending.Review preview={pending.preview} fixedContent={fixedContent} busy={busy}
      feedback={error && <ConfirmationFailure message={error} />} changeLanguage={changeLanguage} accept={() => void accept()} />}
    </Dialog>
  </>;
}
