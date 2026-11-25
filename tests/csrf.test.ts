import { describe, expect, it } from "vitest";
import { assertSameOrigin, isSameOriginRequest, siteOrigin } from "~/lib/http/csrf.server";
import { normalizeInvitationFormOrigin } from "../server/invitation-form-origin";

const BASE = "http://localhost:5173";
const post = (headers: Record<string, string> = {}, method = "POST") => new Request(`${BASE}/settings`, { method, headers });

describe("same-origin check for resource route actions", () => {
  it("accepts the site's own origin", () => {
    expect(isSameOriginRequest(post({ origin: BASE }))).toBe(true);
    expect(() => assertSameOrigin(post({ origin: BASE }))).not.toThrow();
  });

  it("rejects another origin, a different port or scheme, and the string null", () => {
    for (const origin of ["http://evil.example", "https://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173", "http://localhost:5173.evil.example", "null", ""]) {
      expect(isSameOriginRequest(post({ origin })), origin).toBe(false);
    }
  });

  it("falls back to Sec-Fetch-Site when there is no Origin", () => {
    expect(isSameOriginRequest(post({ "sec-fetch-site": "same-origin" }))).toBe(true);
    for (const site of ["cross-site", "same-site", "none"]) expect(isSameOriginRequest(post({ "sec-fetch-site": site })), site).toBe(false);
  });

  it("lets Origin decide when both are present, and rejects requests with neither", () => {
    expect(isSameOriginRequest(post({ origin: "http://evil.example", "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isSameOriginRequest(post({ origin: BASE, "sec-fetch-site": "cross-site" }))).toBe(true);
    expect(isSameOriginRequest(post())).toBe(false);
  });

  it("does not check safe methods", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(isSameOriginRequest(post({ origin: "http://evil.example" }, method) as Request)).toBe(true);
  });

  it("throws a 403 response for a foreign origin", () => {
    try {
      assertSameOrigin(post({ origin: "http://evil.example" }));
      throw new Error("did not throw");
    } catch (thrown) {
      expect((thrown as { init?: { status?: number } }).init?.status).toBe(403);
    }
  });

  it("compares with the origin of BETTER_AUTH_URL (path ignored), or an explicitly given one", () => {
    expect(siteOrigin("https://forum.example.org/some/path")).toBe("https://forum.example.org");
    expect(siteOrigin()).toBe(BASE); // Test default.
    expect(isSameOriginRequest(post({ origin: "https://forum.example.org" }), siteOrigin("https://forum.example.org/"))).toBe(true);
    expect(isSameOriginRequest(post({ origin: BASE }), siteOrigin("https://forum.example.org/"))).toBe(false);
  });
});

describe("native invitation forms under a no-referrer policy", () => {
  const browserHeaders = { origin: "null", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

  it.each(["/invites/new", "/invites/shared"])("uses the same-origin navigation check for %s", url => {
    const headers = { ...browserHeaders };
    normalizeInvitationFormOrigin({ method: "POST", url, headers }, undefined, () => {});
    expect(headers).not.toHaveProperty("origin");
    expect(isSameOriginRequest(new Request(`${BASE}${url}`, { method: "POST", headers }))).toBe(true);
  });

  it("preserves the origin for other requests", () => {
    for (const request of [
      { method: "GET", url: "/invites/new", headers: {} },
      { url: "/settings", headers: {} },
      { url: "/invites/shared.data", headers: {} },
      { url: "/invites/shared", headers: { origin: "https://other.example" } },
      { url: "/invites/shared", headers: { "sec-fetch-site": "cross-site" } },
      { url: "/invites/shared", headers: { "sec-fetch-site": "same-site" } },
      { url: "/invites/shared", headers: { "sec-fetch-site": undefined } },
      { url: "/invites/shared", headers: { "sec-fetch-mode": "cors" } },
      { url: "/invites/shared", headers: { "sec-fetch-dest": "iframe" } },
      { url: "/invites/shared", headers: { referer: BASE } },
    ]) {
      const headers = { ...browserHeaders, ...request.headers };
      const origin = headers.origin;
      normalizeInvitationFormOrigin({ method: "POST", ...request, headers }, undefined, () => {});
      expect(headers.origin).toBe(origin);
    }
  });
});
