import { AsyncLocalStorage } from "node:async_hooks";
import { createCimdClientDiscovery, validateCimdMetadata } from "@better-auth/cimd";
import type { ClientDiscovery } from "@better-auth/oauth-provider";
import { MetadataFetchBusy, type MetadataFetch } from "./cimd.server";

export const CIMD_CACHE = {
  defaultSeconds: 3600,
  minSeconds: 0,
  maxSeconds: 3600,
  staleSeconds: 86400,
  maxEntries: 1000,
} as const;
const profile = "mcp-2026-07-28";
const jsonMediaType = /^application\/(?:[-\w.]+\+)?json\s*(?:;|$)/i;
const transientCodes = new Set(["EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"]);
const cacheHeaders = ["cache-control", "vary", "expires", "date", "age", "etag", "last-modified"];
const maxDocumentBytes = 5 * 1024;

type Entry = { body: string; headers: Headers; freshUntil: number; staleUntil: number; applied: boolean };
class TemporarilyUnavailableCimd extends Error {
  constructor(readonly canUseStoredMetadata: () => boolean) {
    super("Client metadata host is temporarily unavailable");
  }
}

export type MetadataSources = {
  document: MetadataFetch;
  keys: MetadataFetch;
  isFresh: (clientId: string) => boolean;
  confirm: (clientId: string, body: string) => void;
};

function freshness(headers: Headers, now: number) {
  const directives = headers.get("cache-control")?.split(",").map(value => value.trim().toLowerCase().split(/\s*=\s*/, 2)) ?? [];
  const has = (name: string) => directives.some(([key]) => key === name);
  if (has("no-store") || has("private") || headers.get("vary")?.split(",").some(value => value.trim() === "*")) return null;
  const ages = directives.filter(([name]) => name === (has("s-maxage") ? "s-maxage" : "max-age"));
  const rawAge = ages[0]?.[1]?.replace(/^"(.*)"$/, "$1");
  const explicit = ages.length ? (ages.length === 1 && /^\d+$/.test(rawAge ?? "") ? Number(rawAge) : 0) : undefined;
  const date = Date.parse(headers.get("date") ?? "");
  const expires = Date.parse(headers.get("expires") ?? "");
  const originLifetime = explicit ?? (Number.isFinite(expires) ? (expires - (Number.isFinite(date) ? date : now)) / 1000 : CIMD_CACHE.defaultSeconds);
  const age = Math.max(Number(headers.get("age")) || 0, Number.isFinite(date) ? (now - date) / 1000 : 0);
  const lifetime = has("no-cache") ? 0 : Math.max(CIMD_CACHE.minSeconds, Math.min(CIMD_CACHE.maxSeconds, originLifetime - age));
  const freshUntil = now + lifetime * 1000;
  const staleUntil = lifetime && !has("must-revalidate") && !has("proxy-revalidate") && !has("s-maxage")
    ? freshUntil + CIMD_CACHE.staleSeconds * 1000 : freshUntil;
  return { freshUntil, staleUntil };
}

function documentResponse(body: string) {
  // The shared cache owns freshness and validators across database bindings.
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function createCimdMetadataSources(fetch: MetadataFetch): MetadataSources {
  const entries = new Map<string, Entry>();
  const read = (clientId: string) => {
    const entry = entries.get(clientId);
    if (entry) {
      entries.delete(clientId);
      entries.set(clientId, entry);
    }
    return entry;
  };
  const document: MetadataFetch = async (input, init) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const clientId = typeof input === "string" ? input : request.url;
    const previous = read(clientId);
    if (previous?.applied && Date.now() < previous.freshUntil) return documentResponse(previous.body);
    const headers = new Headers(request.headers);
    const etag = previous?.headers.get("etag");
    const modified = previous?.headers.get("last-modified");
    if (etag) headers.set("if-none-match", etag);
    if (modified) headers.set("if-modified-since", modified);
    const canUseStoredMetadata = () => !!previous?.applied && entries.get(clientId) === previous && Date.now() < previous.staleUntil;
    let response: Response;
    try {
      response = await fetch(input, { ...init, headers });
    } catch (error) {
      const failure = error as { name?: string; code?: string } | null;
      if (!request.signal.aborted && canUseStoredMetadata()
          && (error instanceof MetadataFetchBusy || failure?.name === "TimeoutError" || transientCodes.has(failure?.code ?? ""))) throw new TemporarilyUnavailableCimd(canUseStoredMetadata);
      throw error;
    }
    if ([500, 502, 503, 504].includes(response.status)) {
      if (canUseStoredMetadata()) throw new TemporarilyUnavailableCimd(canUseStoredMetadata);
      return response;
    }
    let next: { body: string; headers: Headers } | undefined;
    if (response.status === 304 && previous && (etag || modified)) {
      const merged = new Headers(previous.headers);
      for (const field of cacheHeaders) {
        const value = response.headers.get(field);
        if (value !== null) merged.set(field, value);
        else if (field === "date" || field === "age") merged.delete(field);
      }
      next = { body: previous.body, headers: merged };
    } else if (response.status === 200 && jsonMediaType.test(response.headers.get("content-type") ?? "")) {
      const original = await response.clone().arrayBuffer();
      if (original.byteLength <= maxDocumentBytes && Number(response.headers.get("content-length")) <= maxDocumentBytes) {
        const body = new TextDecoder().decode(original);
        let document: unknown;
        try { document = JSON.parse(body); }
        catch { /* The provider reports invalid JSON using its usual error format. */ }
        if (validateCimdMetadata(clientId, document, { metadataProfile: profile }).valid) {
          const headers = new Headers();
          for (const field of cacheHeaders) {
            const value = response.headers.get(field);
            if (value !== null) headers.set(field, value);
          }
          next = { body, headers };
        }
      }
    }
    entries.delete(clientId);
    if (!next) return response;
    const times = freshness(next.headers, Date.now());
    if (times) {
      entries.set(clientId, { body: next.body, headers: next.headers, ...times, applied: !!previous?.applied && previous.body === next.body });
      if (entries.size > CIMD_CACHE.maxEntries) entries.delete(entries.keys().next().value!);
    }
    return documentResponse(next.body);
  };
  return {
    document,
    keys: fetch,
    isFresh: clientId => {
      const entry = read(clientId);
      return !!entry?.applied && Date.now() < entry.freshUntil;
    },
    confirm: (clientId, body) => {
      const entry = entries.get(clientId);
      if (entry?.body === body) entry.applied = true;
    },
  };
}

export function mcpCimdDiscovery(sources: MetadataSources): ClientDiscovery {
  const attempts = new AsyncLocalStorage<{ temporaryFailure?: TemporarilyUnavailableCimd; body?: string }>();
  const logged = new WeakSet<object>();
  const discovery = createCimdClientDiscovery({
    metadataProfile: profile,
    fetchClientMetadataResource: async (input, init) => {
      try {
        const response = await sources.document(input, init);
        if (response.status === 200) attempts.getStore()!.body = await response.clone().text();
        return response;
      } catch (error) {
        if (error instanceof TemporarilyUnavailableCimd) attempts.getStore()!.temporaryFailure = error;
        throw error;
      }
    },
  });
  return {
    ...discovery,
    fetchClientMetadataResource: sources.keys,
    resolve: (ctx, clientId, existingClient) => {
      const attempt: NonNullable<ReturnType<typeof attempts.getStore>> = {};
      return attempts.run(attempt, async () => {
        // The provider has just read this row. Use its current flags and
        // metadata, including changes applied by another process.
        if (existingClient && sources.isFresh(clientId)) return existingClient;
        try {
          const client = await discovery.resolve(ctx, clientId, existingClient);
          if (client && attempt.body !== undefined) sources.confirm(clientId, attempt.body);
          return client;
        } catch (error) {
          if (!attempt.temporaryFailure?.canUseStoredMetadata() || !existingClient || ctx.path !== "/oauth2/token" || ctx.body?.grant_type !== "refresh_token") throw error;
          // Keep the database's current client state when the document host is
          // temporarily unavailable. Fresh authorization still needs a live document.
          if (!logged.has(ctx)) {
            logged.add(ctx);
            ctx.context.logger.warn("Using stored CIMD metadata during a temporary fetch failure");
          }
          return existingClient;
        }
      });
    },
  };
}
