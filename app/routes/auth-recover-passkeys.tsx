import { useState } from "react";
import { Button } from "~/components/ui/button";
import { getAuth, issuePasskeySession } from "~/lib/auth/auth.server";
import { finishPasskeyRecovery, recoveryRegistrationOptions } from "~/lib/auth/passkeys.server";
import { getDb } from "~/lib/db/client.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceIpLimit } from "~/lib/http/limits.server";
import { SigningError } from "~/lib/signing.server";
import { m } from "~/paraglide/messages.js";
import type { Route } from "./+types/auth-recover-passkeys";

const privacyHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
export function headers() { return privacyHeaders; }
export function meta() { return [{ title: m.passkey_recovery_title() }]; }

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const db = await getDb();
  await enforceIpLimit(db, request, "auth-page");
  try {
    const body = await request.json();
    if (body?.intent === "options") return Response.json(await recoveryRegistrationOptions(db, body.token), { headers: privacyHeaders });
    if (body?.intent !== "verify" || typeof body.challenge !== "string") throw new SigningError("invalid_payload", 400);
    const auth = await getAuth();
    const cookies = await finishPasskeyRecovery(db, body.token, body.challenge, body.response, (tx, userId, at, key) => issuePasskeySession(auth, tx, userId, at, key));
    for (const [name, value] of Object.entries(privacyHeaders)) cookies.set(name, value);
    return Response.json({ ok: true }, { headers: cookies });
  } catch (error) {
    if (error instanceof SigningError || error instanceof SyntaxError) {
      return Response.json({ error: "recovery_failed" }, { status: error instanceof SigningError ? error.status : 400, headers: privacyHeaders });
    }
    throw error;
  }
}

export default function PasskeyRecovery() {
  const [status, setStatus] = useState<"ready" | "busy" | "error">("ready");
  async function recover() {
    setStatus("busy");
    try {
      const { recoverVerifiedPasskey } = await import("~/lib/passkeys.client");
      await recoverVerifiedPasskey(window.location.hash.slice(1));
      window.location.replace("/settings#settings-passkeys");
    } catch { setStatus("error"); }
  }
  return <main className="mx-auto max-w-lg space-y-4 px-4 py-8">
    <h1 className="text-2xl font-bold">{m.passkey_recovery_title()}</h1>
    <p>{m.passkey_recovery_help()}</p>
    {status === "error" && <p role="alert">{m.passkey_recovery_failed()}</p>}
    <Button type="button" disabled={status === "busy"} onClick={() => void recover()}>{m.settings_passkeys_add()}</Button>
  </main>;
}
