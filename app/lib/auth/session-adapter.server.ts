import { AsyncLocalStorage } from "node:async_hooks";
import { getCurrentAdapter, type BetterAuthOptions, type DBTransactionAdapter } from "better-auth";
import { isDeletedIdentity } from "../deleted-member";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Db, Tx } from "~/lib/db/client.server";
import * as schema from "~/lib/db/schema";
import { RETENTION, DAY_MS } from "~/lib/retention";
import { invitationRequired } from "./invitation-ref.server";
import { redeemSignupInvitation, type SignupInvitationGrant } from "./signup-invitation.server";
import { DCR_JWKS_DISCOVERY_ID } from "~/lib/mcp/cimd.server";
import { deleteRefreshLineAccessTokens, refreshReplayScope, stopRefreshLine } from "~/lib/mcp/refresh-revocation.server";

// The OAuth provider must keep its default client model name, "oauthClient".
const disabledClientLogout = {
  backchannelLogoutUri: null,
  backchannelLogoutSessionRequired: null,
  postLogoutRedirectUris: null,
  enableEndSession: null,
};

type Adapter = ReturnType<ReturnType<typeof drizzleAdapter>>;
type SessionQuery = Parameters<Adapter["findOne"]>[0];
type DeleteQuery = Parameters<Adapter["deleteMany"]>[0];

function matchesDeleteCondition(condition: DeleteQuery["where"][number], field: string, value: string | null, operator?: "ne") {
  return condition.field === field && condition.value === value && condition.operator === operator
    && Object.keys(condition).length === (operator ? 3 : 2);
}

function isRefreshReplayDeletion({ model, where }: DeleteQuery, clientId: string, userId: string) {
  // Match only the provider's invalidateRefreshFamily filters. This hook is
  // active only while the provider handles a refresh grant for a known token.
  const family = model === "oauthRefreshToken" ? where.length === 2
    : model === "oauthAccessToken" && where.length === 3 && matchesDeleteCondition(where[2], "refreshId", null, "ne");
  return family && matchesDeleteCondition(where[0], "clientId", clientId) && matchesDeleteCondition(where[1], "userId", userId);
}

function bounded<T extends { model: string; where?: SessionQuery["where"] }>(query: T): T {
  return query.model === "session" ? { ...query, where: [...query.where ?? [], { field: "createdAt", operator: "gt" as const, value: new Date(Date.now() - RETENTION.sessionAbsoluteDays * DAY_MS) }] } : query;
}

function allowed(value: unknown, model: string): boolean {
  if (!value || typeof value !== "object") return true;
  const row = value as { id?: string; email?: string; userId?: string; user?: { id?: string; email?: string } };
  return model === "user" ? !isDeletedIdentity(row.id, row.email)
    : model !== "session" || (!isDeletedIdentity(row.userId) && !isDeletedIdentity(row.user?.id, row.user?.email));
}

// Enforce the lifetime at the authoritative read, including library middleware
// that calls getSession internally instead of the app's session helper.
function wrap<T extends Pick<Adapter, "create" | "findOne" | "findMany" | "deleteMany">>(adapter: T, db: Db,
  createUser: Adapter["create"], makeAdapter: (db: Db) => Adapter): T {
  return {
    ...adapter,
    create: query => {
      if (query.model === "user") return createUser(query);
      if (query.model === "oauthClient") return adapter.create({ ...query, data: { ...query.data, ...disabledClientLogout } });
      // Roll back duplicate assertion inserts to a savepoint so the provider
      // can read the existing row and return invalid_client.
      if (query.model === "oauthClientAssertion" && is(db, PgTransaction)) {
        return db.transaction(tx => makeAdapter(tx).create(query));
      }
      return adapter.create(query);
    },
    findOne: async <R>(query: Parameters<Adapter["findOne"]>[0]) => {
      const value = await adapter.findOne<R>(bounded(query));
      if (query.model === "oauthClient" && value) {
        const client = value as { clientDiscoveryId?: string; tokenEndpointAuthMethod?: string; jwksUri?: string };
        // Better Auth chooses the remote JWKS transport by discovery id. Use the
        // staged transport for this read without changing the stored DCR client.
        if (!client.clientDiscoveryId && client.tokenEndpointAuthMethod === "private_key_jwt" && client.jwksUri) {
          return { ...value, ...disabledClientLogout, clientDiscoveryId: DCR_JWKS_DISCOVERY_ID };
        }
        return { ...value, ...disabledClientLogout };
      }
      return allowed(value, query.model) ? value : null;
    },
    findMany: async <R>(query: Parameters<Adapter["findMany"]>[0]) => {
      const values = await adapter.findMany<R>(bounded(query));
      // Keep session-bound token revocation while suppressing client logout delivery.
      if (query.model === "oauthClient") return values.map(value => ({ ...value, ...disabledClientLogout }));
      return values.filter(value => allowed(value, query.model));
    },
    deleteMany: async query => {
      const replay = refreshReplayScope.getStore();
      if (!replay || !isRefreshReplayDeletion(query, replay.sent.clientId, replay.sent.userId)) return adapter.deleteMany(query);
      const { sent } = replay;
      if (!sent.authorizationCodeId) {
        const count = await adapter.deleteMany(query);
        if (query.model === "oauthRefreshToken") replay.outcome = { deletedCount: count };
        return count;
      }
      const line = { ...sent, authorizationCodeId: sent.authorizationCodeId };
      if (query.model === "oauthAccessToken") return deleteRefreshLineAccessTokens(db, line);
      const now = new Date();
      const stopped = await stopRefreshLine(db, line, now);
      replay.outcome = {
        ...stopped,
        secondsSinceRotation: sent.rotatedAt ? Math.max(0, Math.floor((now.getTime() - sent.rotatedAt.getTime()) / 1000)) : null,
      };
      // deleteMany counts physical deletions. The refresh rows are retained.
      return 0;
    },
  };
}

export function sessionWriteScope(db: Db) {
  const transaction = new AsyncLocalStorage<Tx>();
  const connections = new WeakMap<object, Db>();
  return { transaction, connections, run: async <T, Options extends BetterAuthOptions>(adapter: DBTransactionAdapter<Options>, work: () => Promise<T>): Promise<T> => {
    const active = transaction.getStore();
    if (active) return work();
    const connection = connections.get(await getCurrentAdapter(adapter)) ?? db;
    return is(connection, PgTransaction) ? transaction.run(connection as Tx, work) : connection.transaction(tx => transaction.run(tx, work));
  } };
}

export function sessionAdapter(db: Db, signupGrants = new Map<string, SignupInvitationGrant>(), scope = sessionWriteScope(db)): ReturnType<typeof drizzleAdapter> {
  return options => {
    const makeAdapter = (connection: Db) => drizzleAdapter(connection, { provider: "pg", schema })(options);
    function forConnection(connection: Db): Adapter {
      const adapter = makeAdapter(connection);
      const createUser = async <T extends Record<string, unknown>, R = T>(query: {
        model: string; data: Omit<T, "id">; select?: string[]; forceAllowId?: boolean;
      }): Promise<R> => {
        const { id, email } = query.data as { id?: string; email?: string };
        const grant = id && signupGrants.get(id);
        if (!id || !email || !grant) throw invitationRequired();
        try {
          return await connection.transaction(async tx => {
            await redeemSignupInvitation(tx, id, email, grant);
            return await makeAdapter(tx).create<T, R>(query);
          });
        } finally {
          signupGrants.delete(id);
        }
      };
      const wrapped = wrap(adapter, connection, createUser, makeAdapter);
      const result: Adapter = {
        ...wrapped,
        create: query => {
          const tx = scope.transaction.getStore();
          return tx && tx !== connection && (query.model === "session" || query.model === "account") ? makeAdapter(tx).create(query) : wrapped.create(query);
        },
        update: async <R>(query: Parameters<Adapter["update"]>[0]) => {
          if (query.model === "oauthClient") {
            // The provider has validated the metadata. Preserve any existing
            // logout columns while keeping them out of registration writes and results.
            const { backchannelLogoutUri: _uri, backchannelLogoutSessionRequired: _required,
              postLogoutRedirectUris: _redirects, enableEndSession: _endSession, ...update } = query.update;
            const client = await wrapped.update<R>({ ...query, update });
            return client && { ...client, ...disabledClientLogout };
          }
          const tx = scope.transaction.getStore();
          return query.model === "account" && tx && tx !== connection ? makeAdapter(tx).update<R>(query) : wrapped.update<R>(query);
        },
        transaction: <R>(callback: (trx: Adapter) => Promise<R>) => connection.transaction(tx => callback(forConnection(tx))),
      };
      scope.connections.set(result, connection);
      return result;
    }
    return forConnection(db);
  };
}
