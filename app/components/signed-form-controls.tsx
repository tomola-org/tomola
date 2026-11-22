import { UnsavedFormGuard } from "~/components/unsaved-form-guard";
import { useContext, useEffect, useImperativeHandle, useRef, useState } from "react";
import { FormLanguageChangeContext, FormVillageReviewContext } from "~/components/form-contexts";
import type { FormSubmitHandler, SignedFormControlsProps } from "~/components/signed-form-frame";
import { flushSync } from "react-dom";
import { Dialog } from "~/components/ui/dialog";
import { useNavigation, useSubmit } from "react-router";
import { loadSigningAuthentication } from "~/lib/signing-authentication";
import { DRAFT_CONFIRMATION_FIELD, SIGNATURE_ASSERTION_FIELD, SIGNATURE_CHALLENGE_FIELD, type SigningOptions, type SigningPreview } from "~/lib/signing";
import { m } from "~/paraglide/messages.js";
import { readerLoginHref } from "~/lib/public-reading";

type Pending = { fields: [string, string][]; action: string; preview: SigningPreview; Review: typeof import("./signing-review").default };
class SigningRequestError extends Error {
  constructor(code: string, readonly village?: string, readonly explanation?: string) { super(code); }
}
async function signingRequest(body: unknown) {
  const response = await fetch("/signing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual", cache: "no-store" });
  if (response.status === 401 || response.type === "opaqueredirect") throw new SigningRequestError("login_required");
  if (response.status >= 500 && !response.headers.get("Content-Type")?.includes("application/json")) throw new SigningRequestError("network_failed");
  let result;
  try { result = await response.json(); }
  catch { throw new SigningRequestError("network_failed"); }
  if (result?.error === "maintenance_readonly") throw new SigningRequestError("maintenance_readonly", undefined, typeof result.message === "string" ? result.message : undefined);
  if (response.status >= 500) throw new SigningRequestError("network_failed");
  if (!response.ok) throw new SigningRequestError(typeof result?.error === "string" ? result.error : "signature_failed", typeof result?.village === "string" ? result.village : undefined);
  return result;
}
function signingFailureMessage(error: unknown, draftConflictMessage?: string): string {
  if (error instanceof SigningRequestError && error.message === "maintenance_readonly") return error.explanation || m.maintenance_readonly();
  if (error instanceof SigningRequestError && error.message === "login_required") return m.signing_login_required();
  if (error instanceof SigningRequestError && error.message === "draft_conflict") return draftConflictMessage ?? m.ai_write_conflict();
  if (error instanceof Error && error.message === "body_too_complex") return m.error_body_too_complex();
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  if (cause instanceof Error && cause.name === "NotAllowedError") return m.signing_cancelled();
  if (error instanceof TypeError || error instanceof SigningRequestError && error.message === "network_failed") return m.signing_network_failed();
  if (typeof window.PublicKeyCredential === "undefined" || cause instanceof Error && cause.name === "NotSupportedError") return m.signing_unsupported();
  return m.signing_failed();
}
function SigningFailure({ message }: { message: string }) {
  return <><p role="alert" className="text-destructive">{message}</p>{message === m.signing_login_required() && <a className="underline" href={readerLoginHref(`${window.location.pathname}${window.location.search}${window.location.hash}`, "")} target="_blank" rel="noreferrer noopener">{m.login_title()}</a>}</>;
}
const pairsOf = (form: FormData) => [...form.entries()].map(([name, value]) => [name, String(value)] as [string, string]);

// Keep the accepted snapshot immutable. Ordinary writes and draft saves retain native form submission.
export default function SignedFormControls({ signatureRequired, protectUnsaved, unsavedInitialValues, preserveUnsavedOnSamePath, confirmAiDraft = false, signIntent, fixedSigningContent, draftConflictMessage, action: formAction, form: element, bypass, review, setReady }: SignedFormControlsProps) {
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
  const [authenticate, setAuthenticate] = useState<Awaited<ReturnType<typeof loadSigningAuthentication>> | null>(null);
  useEffect(() => {
    if (!pending?.preview.signatureRequired) return;
    let active = true;
    // Finish loading before the confirmation button can request a passkey.
    // A failed load returns to the unchanged form and its existing retry path.
    void loadSigningAuthentication().then(start => {
      if (active) setAuthenticate(() => start);
    }).catch(failure => {
      if (active) { setPending(null); setError(signingFailureMessage(failure)); }
    });
    return () => { active = false; };
  }, [pending]);
  const submission = useRef<HTMLButtonElement | HTMLInputElement | null>(null);
  const changeFormLanguage = useContext(FormLanguageChangeContext);
  const reviewFormVillage = useContext(FormVillageReviewContext);
  function recoverVillage(failure: unknown, fields: [string, string][]): boolean {
    if (!(failure instanceof SigningRequestError)) return false;
    const code = failure.message;
    if (code !== "village_required" && (code !== "village_changed" || !failure.village)) return false;
    setPending(null);
    if (!unchanged({ fields })) { setError(m.signing_changed()); return true; }
    reviewFormVillage?.current?.(failure.village, fields.find(([name]) => name === "body")?.[1] ?? "", code);
    setError(reviewFormVillage?.current ? null : code === "village_required" ? m.village_required() : m.village_changed());
    return true;
  }
  async function reviewSubmission(event: Parameters<FormSubmitHandler>[0]) {
    if (!signatureRequired && !confirmAiDraft) { allowSubmission(); return; }
    const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | HTMLInputElement | null;
    const form = new FormData(event.currentTarget, button);
    const intent = String(form.get("intent") ?? "");
    if (signIntent !== undefined ? intent !== signIntent : ["draft", "save", "remove_alt", "preview"].includes(intent)) { allowSubmission(); return; }
    event.preventDefault();
    if (busy) return;
    submission.current = button;
    const fields = pairsOf(form);
    const action = new URL(typeof formAction === "string" ? formAction : window.location.href, window.location.href).pathname + (typeof formAction === "string" ? new URL(formAction, window.location.href).search : window.location.search);
    setBusy(true); setError(null);
    element.current?.dispatchEvent(new Event("tomola:village-review-reset"));
    try {
      const preview = await signingRequest({ intent: "preview", pathname: new URL(action, window.location.href).pathname, fields }) as SigningPreview;
      if (!preview.signatureRequired && !preview.confirmation && !preview.lastEditor?.id) {
        await submit(form, { method: "post", action });
      } else {
        const { default: Review } = await import("./signing-review");
        setPending({ fields, action, preview, Review });
      }
    } catch (error) {
      if (!recoverVillage(error, fields)) setError(signingFailureMessage(error, draftConflictMessage));
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
      for (const [name, value] of snapshot.fields) {
        if (name !== SIGNATURE_CHALLENGE_FIELD && name !== SIGNATURE_ASSERTION_FIELD) form.append(name, value);
      }
      if (snapshot.preview.signatureRequired) {
        if (!authenticate) return;
        if (typeof window.PublicKeyCredential === "undefined" || !navigator.credentials?.get) throw new DOMException("Passkeys unavailable", "NotSupportedError");
        const options = await signingRequest({ intent: "challenge", pathname: new URL(snapshot.action, window.location.href).pathname, fields: snapshot.fields, previewHash: snapshot.preview.payloadHash }) as SigningOptions;
        const assertion = await authenticate({ optionsJSON: options.options });
        if (!unchanged(snapshot)) { setPending(null); setError(m.signing_changed()); return; }
        form.set(SIGNATURE_CHALLENGE_FIELD, options.challenge);
        form.set(SIGNATURE_ASSERTION_FIELD, JSON.stringify(assertion));
      }
      if (snapshot.preview.confirmation) form.set(DRAFT_CONFIRMATION_FIELD, snapshot.preview.confirmation);
      setPending(null);
      await submit(form, { method: "post", action: snapshot.action });
    } catch (failure) {
      if (recoverVillage(failure, snapshot.fields)) return;
      if (failure instanceof Error && failure.message === "approval_changed") {
        try { const preview = await signingRequest({ intent: "preview", pathname: new URL(snapshot.action, window.location.href).pathname, fields: snapshot.fields }) as SigningPreview; setPending({ ...snapshot, preview }); } catch (error) { if (recoverVillage(error, snapshot.fields)) return; setPending(null); setError(signingFailureMessage(error, draftConflictMessage)); return; }
        setError(m.signing_changed());
      } else setError(signingFailureMessage(failure, draftConflictMessage));
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
      const preview = await signingRequest({ intent: "preview", pathname: new URL(snapshot.action, window.location.href).pathname, fields }) as SigningPreview;
      setPending({ ...snapshot, fields, preview });
    } catch (error) { if (!recoverVillage(error, fields)) { setPending(null); setError(signingFailureMessage(error)); } }
    finally { setBusy(false); }
  }
  return <>
    {protectUnsaved && <UnsavedFormGuard form={element} mode={protectUnsaved} bypass={bypass} initial={unsavedInitialValues} retainOnSamePath={preserveUnsavedOnSamePath} />}
    {!pending && error && <SigningFailure message={error} />}
    <Dialog open={pending !== null} disablePointerDismissal onOpenChange={(open, details) => {
      if (open) return;
      if (busy) { details.cancel(); return; }
      setPending(null); setError(null);
    }}>
    {pending && <pending.Review preview={pending.preview} fixedSigningContent={fixedSigningContent} busy={busy} canSign={Boolean(authenticate)}
      feedback={error && <SigningFailure message={error} />} changeLanguage={changeLanguage} accept={() => void accept()} />}
    </Dialog>
  </>;
}
