import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { internalLogin } from "./login-method.server";

// This endpoint is only called by the server inside a transaction that has
// already checked a passkey assertion or verified a recovery registration.
export const passkeySessionPlugin = {
  id: "tomola-passkey-session",
  endpoints: {
    issuePasskeySession: createAuthEndpoint("/tomola/passkey-session", { method: "POST" }, async ctx => {
      const proof = internalLogin.getStore();
      if (proof?.method !== "passkey") throw new APIError("NOT_FOUND");
      const adapter = ctx.context.internalAdapter;
      const user = await adapter.findUserById(proof.userId);
      if (!user) throw new APIError("UNAUTHORIZED");
      const session = await adapter.createSession(user.id);
      if (!session) throw new APIError("UNAUTHORIZED");
      await setSessionCookie(ctx, { session, user });
      return ctx.json({ ok: true });
    }),
  },
};
