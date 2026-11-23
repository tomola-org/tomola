import { and, eq, gt, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { AsyncLocalStorage } from "node:async_hooks";
import { passkey, profiles, pushSubscriptions, session } from "../db/schema";
import { isDeletedIdentity } from "../deleted-member";
import { randomUUID } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getOAuthState, isAPIError } from "better-auth/api";
import { googleLoginConfig } from "./google-config.server";
import { finishGoogleFlow, googleInvitationRef, prepareGoogleFlow, validateGoogleUser } from "./google-policy.server";
import { getDb, type Db, type Tx } from "~/lib/db/client.server";
import { sessionAdapter, sessionWriteScope } from "./session-adapter.server";
import { passkeySessionPlugin } from "./passkey-session.server";
import { internalLogin, linkedGoogle, markVerifiedLogin, passkeyChallengeRevoked, passkeyChallenges, verifiedEmailLogin, verifiedLogin } from "./login-method.server";
import { loginReauthentication } from "./login-reauthentication.server";
import { enqueuePasskeyNotice } from "./passkeys.server";
import { lockSigningMember, SigningError } from "~/lib/signing.server";
import { DAY_MS, RETENTION } from "~/lib/retention";
import { safeErrorText } from "~/lib/error-text.server";
import { getMailer, type Mailer } from "~/lib/mail/mail.server";
import { siteUrl } from "~/lib/site-url";
import { createMagicLinkSender } from "./magic-link.server";
import { authSecret } from "./secret.server";
import { authPlugins, hashMagicLinkToken, type SendMagicLink } from "./plugins";
import { hasSharedInvitationCookie, readInvitationCookie } from "./invitation-cookie.server";
import { invitationRequired, magicLinkInvitationContext } from "./invitation-ref.server";
import type { SignupInvitationGrant } from "./signup-invitation.server";
import { sharedMetadataSources, type MetadataFetch } from "~/lib/mcp/cimd.server";
import type { MetadataSources } from "~/lib/mcp/cimd-cache.server";

type AuthOptions = { baseURL: string; secret: string; sendMagicLink: SendMagicLink; metadataFetch?: MetadataFetch };
const g = globalThis as { __tomolaAuth?: Promise<Auth>; __tomolaAuthOptions?: WeakMap<object, AuthOptions> };
// Configuration must survive the same module reloads as the auth singleton.
const originalOptions = g.__tomolaAuthOptions ??= new WeakMap<object, AuthOptions>();
export function createAuth(db: Db, opts: AuthOptions, preparedMetadata?: MetadataSources) {
  const google = googleLoginConfig();
  const sharedMetadata = sharedMetadataSources(opts.metadataFetch);
  // An auth instance bound to an open transaction cannot observe its commit.
  const metadataSources = preparedMetadata ?? (is(db, PgTransaction) ? { ...sharedMetadata, confirm: () => {} } : sharedMetadata);
  const signupGrants = new Map<string, SignupInvitationGrant>();
  const writes = sessionWriteScope(db);
  const sessionCreation = new AsyncLocalStorage<{ sourceSessionId?: string }>();
  const clearGoogleTokens = { accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null };
  const confirmGoogleConnection = async (context: Parameters<typeof validateGoogleUser>[1] | null) => {
    const state = await getOAuthState();
    if (!state?.link) return;
    const tx = writes.transaction.getStore();
    if (!tx || !context) throw new APIError("UNAUTHORIZED", { code: "google_reauth", message: "Reauthentication required" });
    const userId = state.link.userId;
    await lockSigningMember(tx, userId);
    const current = context.context.session;
    if (current?.user.id !== userId || current.session.id !== state.serverContext?.linkSessionId || !await loginReauthentication(tx, userId, current.session.id)) {
      throw new APIError("UNAUTHORIZED", { code: "google_reauth", message: "Reauthentication required" });
    }
    await enqueuePasskeyNotice(tx, userId, "google_connected", "", new Date());
  };
  const auth = betterAuth({
    baseURL: opts.baseURL,
    secret: opts.secret,
    session: { expiresIn: RETENTION.sessionDays * 86400, updateAge: 86400, additionalFields: {
      loginMethod: { type: "string", required: false, input: false, returned: false },
      reauthenticatedAt: { type: "date", required: false, input: false, returned: false },
      reauthenticationMethod: { type: "string", required: false, input: false, returned: false },
    } },
    database: sessionAdapter(db, signupGrants, writes),
    socialProviders: google ? { google: {
      ...google, disableDefaultScope: true, scope: ["openid", "email"], includeGrantedScopes: false,
      disableIdTokenSignIn: true, overrideUserInfoOnSignIn: false,
      mapProfileToUser: () => ({ name: "", image: undefined }),
    } } : {},
    user: { validateUserInfo: async (input, ctx) => {
      const failure = await validateGoogleUser(input, ctx);
      if (failure || input.source.action !== "link-account" || input.source.oauth?.providerId !== "google") return failure;
      const current = ctx.context.session;
      if (!current || !await loginReauthentication(db, current.user.id, current.session.id)) return { error: "google_reauth" };
    } },
    account: { accountLinking: { disableImplicitLinking: true, allowDifferentEmails: true, allowUnlinkingAll: true, updateUserInfoOnLink: false }, updateAccountOnSignIn: false },
    logger: { level: "warn", log: (level, message, ...args) => {
      const write = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
      write("[auth]", safeErrorText([message, ...args]));
    } },
    hooks: { before: createAuthMiddleware(async ctx => {
      await prepareGoogleFlow(ctx, !!google, (userId, sessionId) => loginReauthentication(db, userId, sessionId));
      const expected = ctx.path === "/magic-link/verify" && typeof ctx.query?.token === "string" ? `magic-link:${hashMagicLinkToken(ctx.query.token)}` : null;
      const passkeyAuthentication = ctx.path === "/passkey/verify-authentication";
      if (expected || passkeyAuthentication) {
        const adapter = ctx.context.internalAdapter;
        // The endpoint's atomic consume returns null for expired and already
        // consumed rows. Other verification deletes do not establish proof.
        ctx.context.internalAdapter = { ...adapter, consumeVerificationValue: async identifier => {
          const value = await adapter.consumeVerificationValue(identifier);
          if (identifier === expected && value?.identifier === expected && value.expiresAt.getTime() > Date.now()) {
            const email = verifiedEmailLogin.getStore();
            markVerifiedLogin(ctx.context, { method: email?.method ?? "email_link", at: email?.fresh === false ? null : new Date(), sourceSessionId: email?.sourceSessionId });
          }
          if (passkeyAuthentication && value) {
            const challenge = JSON.parse(value.value) as { type?: string; userData?: { id?: string }; sessionId?: string };
            if (challenge.type === "authentication") passkeyChallenges.set(ctx.context, { userId: challenge.userData?.id ?? "", sessionId: challenge.sessionId, createdAt: value.createdAt });
          }
          return value;
        } };
      }
      if (ctx.path === "/sign-in/magic-link" && isDeletedIdentity(undefined, ctx.body?.email)) return ctx.json({ status: true });
    }), after: createAuthMiddleware(async ctx => {
      await finishGoogleFlow(ctx, opts.secret);
      if (ctx.path !== "/passkey/generate-authenticate-options") return;
      const result = ctx.context.returned;
      if (result && typeof result === "object" && "challenge" in result && typeof result.challenge === "string") return ctx.json({ ...result, userVerification: "required" });
    }) },
    plugins: [...authPlugins(opts.sendMagicLink, { baseURL: opts.baseURL, metadataSources }), passkeySessionPlugin],
    // Better Auth disables origin checks by default under NODE_ENV=test. Always enable them in every environment.
    // disableIpTracking: do not store IP addresses in sessions (minimize personal data). This also disables Better Auth's own HTTP rate limit
    // based on IPs, but the app has its own login rate limit (magic-link.server.ts) and an HTTP endpoint allowlist (endpoints.server.ts).
    advanced: { disableOriginCheck: false, ipAddress: { disableIpTracking: true } },
    databaseHooks: {
      verification: {
        create: { before: async (value, context) => {
          if (context?.path === "/passkey/generate-authenticate-options" && context.context.session) {
            return { data: { ...value, value: JSON.stringify({ ...JSON.parse(value.value), sessionId: context.context.session.session.id }) } };
          }
          if (context?.path !== "/link-social" || context.body?.provider !== "google") return;
          const state = JSON.parse(value.value);
          // With allowDifferentEmails, link.email is unused. Keep the required
          // string empty; userId and the encrypted session token bind the link.
          if (state.link) return { data: { ...value, value: JSON.stringify({ ...state, link: { ...state.link, email: "" } }) } };
        } },
      },
      account: {
        create: { before: async (value, context) => {
          if (value.providerId !== "google") return;
          await confirmGoogleConnection(context);
          return { data: { ...clearGoogleTokens } };
        } },
        update: { before: async (value, context) => {
          if (context?.path !== "/callback/:id" || context.params?.id !== "google") return;
          await confirmGoogleConnection(context);
          return { data: { ...value, ...clearGoogleTokens } };
        } },
      },
      session: {
        create: {
          // Better Auth stores user agents in sessions without a setting to disable this. Omit them. The setting above omits IPs, which arrive as empty strings; normalize them to null.
          before: async (value, context) => {
            const tx = writes.transaction.getStore();
            const creation = sessionCreation.getStore();
            if (!tx || !creation) throw new Error("Session creation requires a transaction");
            const proof = verifiedLogin(context?.context, value.userId);
            const reject = () => new APIError("UNAUTHORIZED", { code: proof?.method === "google" ? "account_not_linked" : "INVALID_TOKEN", message: "Invalid account" });
            if (!proof) throw reject();
            try { await lockSigningMember(tx, value.userId); }
            catch (error) { if (error instanceof SigningError) throw reject(); throw error; }
            const [profile] = await tx.select({ passkeyOnly: profiles.passkeyOnly }).from(profiles).where(eq(profiles.userId, value.userId));
            if (profile?.passkeyOnly && proof.method !== "passkey") throw reject();
            if (proof.method === "google" && !(await linkedGoogle(tx, value.userId, proof.googleSubject))) throw reject();
            const challenge = proof.credentialId && context ? passkeyChallenges.get(context.context) : undefined;
            if (challenge && ((challenge.userId && challenge.userId !== value.userId) || await passkeyChallengeRevoked(tx, value.userId, challenge.createdAt))) throw reject();
            const sourceSessionId = challenge?.sessionId ?? proof.sourceSessionId;
            if (sourceSessionId) {
              const now = new Date();
              const [origin] = await tx.select({ id: session.id }).from(session).where(and(eq(session.id, sourceSessionId), eq(session.userId, value.userId),
                gt(session.expiresAt, now), gt(session.createdAt, new Date(now.getTime() - RETENTION.sessionAbsoluteDays * DAY_MS)))).for("update");
              if (!origin) throw reject();
              creation.sourceSessionId = sourceSessionId;
            }
            if (proof.credentialId) {
              const [key] = await tx.select({ id: passkey.id, userId: passkey.userId }).from(passkey).where(eq(passkey.credentialID, proof.credentialId));
              if (key?.userId !== value.userId) throw reject();
              if (proof.backedUp !== undefined) await tx.update(passkey).set({ backedUp: proof.backedUp }).where(eq(passkey.id, key.id));
            }
            return { data: { ipAddress: null, userAgent: null, loginMethod: proof.method, reauthenticatedAt: proof.at, reauthenticationMethod: proof.at ? proof.method : null } };
          },
        },
      },
      user: {
        create: {
          // The adapter takes this grant when inserting the user and redeems it
          // in the same transaction. Request cookies cannot change a bound grant.
          before: async (newUser, context) => {
            const id = randomUUID();
            if (isDeletedIdentity(id, newUser.email)) throw invitationRequired();
            const request = context?.request ?? new Request(opts.baseURL, { headers: context?.headers ?? undefined });
            const googleSignup = context?.path === "/callback/:id" && context.params?.id === "google";
            const bound = magicLinkInvitationContext.getStore();
            let grant: SignupInvitationGrant;
            if (googleSignup || bound) {
              const ref = googleSignup ? googleInvitationRef(await getOAuthState()) : bound?.ref;
              if (!ref) throw invitationRequired();
              grant = { ref, strict: true };
            } else {
              const cookie = readInvitationCookie(request, opts.secret);
              if (!cookie && hasSharedInvitationCookie(request)) throw invitationRequired();
              grant = { ref: cookie?.kind === "individual" ? cookie : null, strict: false };
            }
            signupGrants.set(id, grant);
            return { data: { ...newUser, id } };
          },
        },
      },
    },
  });
  // Better Auth runs create.before before calling its database adapter. Wrap the
  // entry point so the hook and the insertion share the same transaction.
  void auth.$context.then(ctx => {
    const adapter = ctx.internalAdapter;
    const createSession = adapter.createSession;
    adapter.createSession = (...args) => writes.run(ctx.adapter, () => {
      const creation: { sourceSessionId?: string } = {};
      return sessionCreation.run(creation, async () => {
        const created = await createSession(...args);
        if (created && creation.sourceSessionId) {
          const tx = writes.transaction.getStore()!;
          await tx.update(pushSubscriptions).set({ authorizingSessionId: created.id, authorizedUntil: created.expiresAt })
            .where(and(eq(pushSubscriptions.userId, created.userId), eq(pushSubscriptions.authorizingSessionId, creation.sourceSessionId)));
          await tx.delete(session).where(and(eq(session.id, creation.sourceSessionId), eq(session.userId, created.userId)));
        }
        return created;
      });
    });
    const createAccount = adapter.createAccount;
    const updateAccount = adapter.updateAccount;
    adapter.createAccount = async (...args) => args[0].providerId === "google" && (await getOAuthState())?.link
      ? writes.run(ctx.adapter, () => createAccount(...args)) : createAccount(...args);
    adapter.updateAccount = async (...args) => (await getOAuthState())?.link
      ? writes.run(ctx.adapter, async () => {
        const account = await updateAccount(...args);
        if (!account) throw new APIError("CONFLICT", { code: "google_reauth", message: "Reauthentication required" });
        return account;
      }) : updateAccount(...args);
  }, () => {});
  originalOptions.set(auth, opts);
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

// Recreate plugins: OAuth discovery initialization mutates plugin options, so reusing plugin instances registers CIMD twice.
export function bindAuthToDatabase(auth: Auth, db: Tx, metadataSources?: MetadataSources): Auth {
  const opts = originalOptions.get(auth);
  if (!opts) throw new Error("Unknown authentication configuration");
  return createAuth(db, opts, metadataSources);
}

export function authMetadataSources(auth: Auth): MetadataSources {
  const opts = originalOptions.get(auth);
  if (!opts) throw new Error("Unknown authentication configuration");
  return sharedMetadataSources(opts.metadataFetch);
}

export function authActiveSecret(auth: Auth): string {
  return originalOptions.get(auth)?.secret ?? authSecret();
}

// The app's Better Auth instance: send magic-link email through the mail system after checking rate limits and the recipient (app/lib/auth/magic-link.server.ts).
export function createAppAuth(
  db: Db,
  opts: { baseURL: string; secret: string; mailer: () => Mailer; now?: () => Date; isKnown?: (db: Db, email: string, now: Date) => Promise<boolean> },
) {
  return createAuth(db, {
    baseURL: opts.baseURL,
    secret: opts.secret,
    sendMagicLink: createMagicLinkSender({ db, baseURL: opts.baseURL, secret: opts.secret, mailer: opts.mailer, now: opts.now, isKnown: opts.isKnown }),
  });
}

// Whether an auth.api call was rejected by the origin check (403). This occurs when the address differs from BETTER_AUTH_URL.
// Rejection throws APIError only when the call receives request and uses asResponse: false.
export function isOriginRejected(error: unknown): boolean {
  return isAPIError(error) && error.statusCode === 403;
}

// Whether an auth.api call failed because of invalid input (400) or origin rejection (403).
export function isRejectedInput(error: unknown): boolean {
  return isOriginRejected(error) || (isAPIError(error) && error.statusCode === 400);
}

// BETTER_AUTH_SECRET moved to ./secret.server (keys of other modules, such as the rate limits, derive from it without loading Better Auth); re-exported for the existing imports.
export { authSecret };

// Public site URL (BETTER_AUTH_URL; http://localhost:5173 in development and tests; app/lib/site-url.ts).
export function authBaseURL(): string {
  return siteUrl();
}

// Do not retain rejected promises, allowing recovery from transient failures or misconfiguration without a restart.
export function getAuth(): Promise<Auth> {
  if (!g.__tomolaAuth) {
    const creating = getDb().then(async (db) => {
      const auth = createAppAuth(db, { baseURL: authBaseURL(), secret: authSecret(), mailer: getMailer });
      // Plugin initialization performs asynchronous schema/key work. Do not expose a half-initialized singleton.
      await auth.$context;
      return auth;
    });
    g.__tomolaAuth = creating;
    creating.catch(() => {
      if (g.__tomolaAuth === creating) g.__tomolaAuth = undefined;
    });
  }
  return g.__tomolaAuth;
}

export async function issuePasskeySession(auth: Auth, db: Tx, userId: string, at: Date, credentialId?: string) {
  const bound = bindAuthToDatabase(auth, db);
  const { headers } = await internalLogin.run({ method: "passkey", userId, at, credentialId }, () => bound.api.issuePasskeySession({ returnHeaders: true }));
  return headers;
}
