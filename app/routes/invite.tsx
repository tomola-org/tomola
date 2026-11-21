import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { parseEmail } from "~/lib/email";
import { getSessionProfile } from "~/lib/auth/session.server";
import { sameInvitation } from "~/lib/auth/invitation-ref.server";
import { loginCodeInvitation } from "~/lib/auth/login-code.server";
import { magicLinkOutcome, sharedInvitationContext, type MagicLinkOutcome } from "~/lib/auth/magic-link.server";
import { findSharedInvitation, sharedInvitationStatus } from "~/lib/shared-invitations.server";
import { useOperatorSettings } from "~/lib/operator-context";
import { participationCopy } from "~/lib/operator-settings";
import { publicReading } from "~/lib/public-reading.server";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { Button } from "~/components/ui/button";
import { LoginCodeForm } from "~/components/login-code-form";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { Form, Link, useLocation, useRevalidator, type MiddlewareFunction } from "react-router";
import { useEffect, useRef } from "react";
import { invitationCookie, clearInvitationCookie, readInvitationCookie } from "~/lib/auth/invitation-cookie.server";
import { invitationVillage } from "~/lib/signup-village.server";
import { pendingLoginCode, prepareLoginCode, rememberedLoginEmail } from "~/lib/auth/login-code-cookie.server";
import { pendingLoginScreen, restartLoginCode } from "~/lib/auth/login-code-state.server";
import { submitLoginCode } from "~/lib/auth/login-code-action.server";
import { loginCodeSent } from "~/lib/auth/login-code-response.server";
import type { Route } from "./+types/invite";
import { GuestHeader } from "~/components/guest-header";
import { EntrySteps } from "~/components/entry-steps";
import { authActiveSecret, getAuth, isOriginRejected, isRejectedInput } from "~/lib/auth/auth.server";
import { getDb } from "~/lib/db/client.server";
import { enforceIpLimit } from "~/lib/http/limits.server";
import { findValidInvitationById, findValidInvitationByToken, invitationSenderHandle, matchesIndividualInvitationToken } from "~/lib/invitations.server";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";
import { readInvitationNote } from "~/lib/invitation-note.server";
import { languageLabel } from "~/lib/language-label";
import { trialParticipationRequired } from "~/lib/notice-sources.server";
import { googleLoginConfig } from "~/lib/auth/google-config.server";
import { googleBrowserFromRequest } from "~/lib/auth/google-browser";
import { startGoogleSignIn } from "~/lib/auth/google-flow.server";
import { maskGoogleInvitationEmail } from "~/lib/auth/google-policy.server";
import { GoogleLogin, GoogleLoginError } from "~/components/google-login";

// Invitation URLs contain secret tokens. Send only the origin as Referer so
// native same-origin form POSTs work without exposing the invitation token.
export function headers() {
  return { "Cache-Control": "no-store", "Referrer-Policy": "strict-origin", "X-Robots-Tag": "noindex" };
}

async function screenInvitation(request: Request, token?: string, ref = readInvitationCookie(request)) {
  const db = await getDb();
  const link = token ? await findSharedInvitation(db, { token }) : ref?.kind === "shared" ? await findSharedInvitation(db, ref) : null;
  if (link) return { kind: "shared" as const, link, ref: { kind: "shared" as const, id: link.id }, status: sharedInvitationStatus(link) };
  const individual = token ? await findValidInvitationByToken(db, token)
    : ref?.kind === "individual" ? await findValidInvitationById(db, ref.id) : null;
  return individual ? { kind: "individual" as const, link: individual, ref: { kind: "individual" as const, id: individual.id }, status: "valid" as const } : null;
}

async function pendingInvitation(request: Request) {
  const pending = pendingLoginCode(request);
  const remembered = rememberedLoginEmail(request);
  if (!pending || !remembered) return null;
  const bound = await loginCodeInvitation(await getDb(), pending, remembered.email, authActiveSecret(await getAuth()));
  return bound ? { ...bound, email: remembered.email } : null;
}

export const middleware: MiddlewareFunction<Response>[] = [async ({ request, params }, next) => {
  const response = await next();
  if (request.method !== "GET" || !response.ok || !params.token) return response;
  const invitation = await screenInvitation(request, params.token);
  const current = readInvitationCookie(request);
  if (invitation?.status === "valid") {
    // A redirect back to a waiting code screen must preserve another tab's invitation.
    if (!current || sameInvitation(current, invitation.ref) || !sameInvitation((await pendingInvitation(request))?.ref ?? null, invitation.ref)) {
      response.headers.append("Set-Cookie", invitationCookie(request, invitation.ref));
    }
  } else if (sameInvitation(current, invitation?.ref ?? null)
      || (current?.kind === "individual" && await matchesIndividualInvitationToken(await getDb(), current.id, params.token))) {
    clearInvitationCookie(request, response.headers);
  }
  return response;
}];

// Invitation POSTs: 300 per IP per 15 minutes (AUTH_PAGE_IP_LIMIT; 429 on excess). Do not count GET page views.
async function loaderImplementation({ params, request }: Route.LoaderArgs) {
  const db = await getDb();
  const invitation = await screenInvitation(request, params.token);
  const individual = invitation?.kind === "individual" ? invitation.link : null;
  const shared = invitation?.kind === "shared";
  const signedIn = shared ? (await getSessionProfile(request))?.handle ?? null : null;
  const valid = invitation?.status === "valid";
  const from = valid ? await invitationSenderHandle(db, invitation.link) : null;
  const url = new URL(request.url);
  const note = individual && from ? await readInvitationNote(db, individual.id, getLocale(), url.searchParams.get("original") === "1") : null;
  const pending = invitation && !signedIn && (valid || (shared && url.searchParams.get("google") !== "1")) ? await pendingInvitation(request) : null;
  const codePending = invitation && pending && (sameInvitation(pending.ref, invitation.ref) || (!pending.ref && individual))
    ? await pendingLoginScreen(db, request, individual?.email) : null;
  return {
    publicReading: publicReading(),
    ...(googleLoginConfig() ? { google: { browser: googleBrowserFromRequest(request), error: url.searchParams.get("error"), email: individual ? maskGoogleInvitationEmail(individual.email) : null } } : {}),
    trialRequired: trialParticipationRequired(),
    email: individual?.email ?? null,
    shared, signedIn, valid, full: shared && invitation.status === "full",
    reopenInvitation: !params.token && !invitation,
    from,
    note: note ? { ...note,
      translationLabel: note.translated ? m.label_from_lang_machine({ lang: languageLabel(note.from) }) : null,
      unavailableLabel: note.unavailable ? m.label_no_translation() : null,
    } : null,
    village: valid && !signedIn ? await invitationVillage(db, invitation.link) : null,
    codePending,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const db = await getDb();
  await enforceIpLimit(db, request, "auth-page");
  const form = await request.formData();
  const intent = form.get("intent");
  const screen = await screenInvitation(request, params.token);
  if (screen?.kind === "shared" && await getSessionProfile(request)) return { sentTo: null, error: "invalid" as const };
  if (intent === "login-restart") return restartLoginCode(request);
  const previous = intent === "login-resend" || intent === "login-code" ? await pendingInvitation(request) : null;
  if (intent === "login-code") {
    if (previous?.ref && params.token && !sameInvitation(previous.ref, screen?.ref ?? null)
      && !(previous.ref.kind === "individual" && await matchesIndividualInvitationToken(db, previous.ref.id, params.token))) {
      return { status: "code_invalid" as const };
    }
    return submitLoginCode(request, form, { invitation: true });
  }
  const boundResend = intent === "login-resend" ? previous?.ref : null;
  if (boundResend && params.token && !sameInvitation(boundResend, screen?.ref ?? null)) {
    return { sentTo: null, error: "invalid" as const };
  }
  const invitation = boundResend && !params.token ? await screenInvitation(request, undefined, boundResend) : screen;
  if (invitation?.status !== "valid") {
    const error = previous?.ref?.kind === "shared" ? "invitation_unavailable" : "invalid";
    return { sentTo: null, error };
  }
  if (intent === "google-login") return startGoogleSignIn(request, "/", invitation.ref);
  const email = invitation.kind === "individual" ? invitation.link.email
    : intent === "login-resend" ? (previous?.ref ? previous.email : null) : parseEmail(String(form.get("email") ?? ""));
  if (!email) return { sentTo: null, error: "invalid_email" as const };
  if (invitation.kind === "shared" && screen?.kind !== "shared" && await getSessionProfile(request)) {
    return { sentTo: null, error: "invalid" as const };
  }
  const auth = await getAuth();
  const pending = prepareLoginCode(request, email, intent === "login-resend");
  const outcome: MagicLinkOutcome = {};
  const browser = pending.browser;
  try {
    // Passing request enables origin validation. asResponse: false makes rejection an exception instead of a Response.
    const send = () => auth.api.signInMagicLink({
      body: { email, metadata: { locale: getLocale(), browserNonce: browser.nonce, codeId: pending.id, invitation: true, invitationRef: invitation.ref } },
      headers: request.headers,
      request,
      asResponse: false,
    });
    if (invitation.kind === "shared") {
      await sharedInvitationContext.run(invitation.ref.id, () => magicLinkOutcome.run(outcome, send));
      if (outcome.result !== "sent") {
        const error = outcome.result === "invitation_unavailable" ? "invitation_unavailable" : "later";
        return { sentTo: null, error };
      }
    } else await send();
  } catch (error) {
    // 403 origin rejection means the opened address differs from configuration. Other rejections indicate invalid input.
    if (isOriginRejected(error)) return { sentTo: null, error: "origin_mismatch" as const };
    if (isRejectedInput(error)) return { sentTo: null, error: "invalid" as const };
    throw error;
  }
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", browser.cookie); headers.append("Set-Cookie", pending.cookie);
  headers.append("Set-Cookie", pending.emailCookie);
  return loginCodeSent(request, { sentTo: email, error: null }, headers);
}

export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.codePending ? m.login_code_heading() : loaderData?.valid || loaderData?.signedIn ? m.invite_title() : m.invite_unusable_title() }];
}

export default function Invite({ loaderData, actionData }: Route.ComponentProps) {
  const policy = useOperatorSettings().participation;
  const revalidator = useRevalidator();
  const location = useLocation();
  const pending = loaderData.note?.pending;
  const polling = useRef<{ key: string; deadline: number } | null>(null);
  useEffect(() => {
    if (!pending) { polling.current = null; return; }
    const key = `${location.pathname}${location.search}`;
    if (polling.current?.key !== key) polling.current = { key, deadline: Date.now() + 45_000 };
    const deadline = polling.current.deadline;
    // Revalidation replaces the revalidator object. Keep the deadline across
    // those renders so a stalled worker cannot keep this tab polling forever.
    const timer = setInterval(() => {
      if (Date.now() >= deadline) { clearInterval(timer); return; }
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 2000);
    return () => clearInterval(timer);
  }, [pending, revalidator, location.pathname, location.search]);
  const noteParams = new URLSearchParams(location.search);
  if (loaderData.note?.translated) noteParams.set("original", "1"); else noteParams.delete("original");
  const noteSearch = noteParams.toString();
  const codeError = actionData && "status" in actionData && actionData.status === "code_invalid";
  const sendError = actionData && "error" in actionData ? actionData.error : null;
  const unavailable = (actionData && "status" in actionData && actionData.status === "invitation_unavailable") || sendError === "invitation_unavailable";
  const heading = unavailable ? m.shared_invite_unavailable()
    : loaderData.signedIn ? m.invite_title()
    : loaderData.codePending ? m.login_code_heading()
    : loaderData.full ? m.shared_invite_full()
    : !loaderData.valid ? m.invite_unusable_title()
    : loaderData.from ? m.invite_title_from({ handle: loaderData.from }) : m.invite_title();
  const showEntrySteps = !unavailable && !loaderData.signedIn && (loaderData.valid || loaderData.codePending);
  return (
    <>
    <GuestHeader />
    <main className="space-y-4">
      {showEntrySteps && <EntrySteps current={loaderData.codePending ? 2 : 1} />}
      <h1 className="text-2xl font-bold">{heading}</h1>
      {sendError === "later" && <p role="alert" className="text-destructive">{m.login_try_later()}</p>}
      {loaderData.note && <div className="space-y-1" data-invitation-note>
        {loaderData.codePending && loaderData.from && <p className="ui-meta text-muted-foreground">{m.invite_title_from({ handle: loaderData.from })}</p>}
        <p className="break-words" dir="auto" lang={loaderData.note.lang}>{loaderData.note.text}</p>
        {loaderData.note.available && <p className="ui-meta text-muted-foreground">
          {loaderData.note.translated ? <span>{loaderData.note.translationLabel}</span> : m.reading_lang_original({ name: languageLabel(loaderData.note.from) })}{" · "}
          <Link to={`${location.pathname}${noteSearch ? `?${noteSearch}` : ""}`} rel="nofollow" preventScrollReset className="underline">{loaderData.note.translated ? m.show_original() : m.show_translation()}</Link>
        </p>}
        {loaderData.note.unavailable && <p className="ui-meta text-muted-foreground">{loaderData.note.unavailableLabel}</p>}
      </div>}
      {loaderData.village && <p className="break-words">{m.invite_village({ village: loaderData.village.name })}</p>}
      {loaderData.village && <p className="ui-help">{m.village_join_visibility()}</p>}
      {loaderData.signedIn ? <>
        <p>{m.shared_invite_signed_in({ handle: loaderData.signedIn })}</p>
        <p className="ui-help">{m.shared_invite_switch_account()}</p>
        <Link to="/" className="underline">{m.confirm_home()}</Link>
      </> : unavailable ? <Link to="/login" className="underline">{m.invite_invalid_login()}</Link> : loaderData.codePending ? <>
        <p className="break-words">{m.invite_sent({ email: loaderData.codePending.email })}</p>
        <LoginCodeForm key={loaderData.codePending.revision} state={loaderData.codePending} invalid={!!codeError} limited={actionData && "limited" in actionData ? actionData.limited : undefined} resentNotice={sendError !== "later"} invitation />
        {actionData && "error" in actionData && actionData.error === "origin_mismatch" && <p className="text-destructive">{m.auth_origin_mismatch()}</p>}
      </> : !loaderData.valid ? <>
        {!loaderData.full && <p>{loaderData.reopenInvitation ? m.google_invitation_reopen() : m.invite_invalid()}</p>}
        <Link to="/login" className="underline">{m.invite_invalid_login()}</Link>
      </> : <>
      <p><span className="block">{m.entry_intro()}</span><span className="block">{m.invite_about()}</span></p>
      {loaderData.publicReading && <p className="ui-help text-muted-foreground">{m.public_reading_onboarding()}</p>}
      {loaderData.google && <><GoogleLoginError {...loaderData.google} /><GoogleLogin browser={loaderData.google.browser} /></>}
      <Form method="post" className="space-y-2">
          {loaderData.shared ? <Field><FieldLabel className="block">{m.login_email()}
            <Input name="email" type="email" required autoComplete="email" />
          </FieldLabel></Field> : loaderData.email && <p>{m.invite_for({ email: loaderData.email })}</p>}
          <p className="ui-help text-muted-foreground">{m.invite_next()}</p>
          {sendError === "invalid" && <p role="alert" className="text-destructive">{m.invite_invalid()}</p>}
          {sendError === "invalid_email" && <p role="alert" className="text-destructive">{m.invites_invalid_email()}</p>}
          {actionData && "error" in actionData && actionData.error === "origin_mismatch" && <p className="text-destructive">{m.auth_origin_mismatch()}</p>}
          {loaderData.trialRequired && <p className="ui-help text-muted-foreground">{participationCopy(policy, getLocale()).invitationRestriction}</p>}
          <Button type="submit">
            {m.invite_submit()}
          </Button>
        </Form>
      {/* The reason the site was made is already linked from the row above and the foot of the page. */}
      {loaderData.publicReading && <p className="ui-help text-muted-foreground">{m.invite_read_first()}{" "}<Link to="/" className="underline">{m.invite_read_posts()}</Link></p>}
      </>}
    </main>
    </>
  );
}

// Native POSTs revalidate loaders inside the original write middleware.
export function loader(...args: Parameters<typeof loaderImplementation>) {
  return withMarkdownRead(() => loaderImplementation(...args));
}
