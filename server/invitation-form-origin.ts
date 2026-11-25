import type { IncomingMessage } from "node:http";

// Referrer-Policy: no-referrer can make a browser send Origin: null on a native form submission.
// For same-origin document navigations to invitation pages, let the action use its
// existing Sec-Fetch-Site fallback. Fetch Metadata is set by the browser.
export function normalizeInvitationFormOrigin(
  { method, url, headers }: Pick<IncomingMessage, "method" | "url" | "headers">,
  _response: unknown,
  next: () => void,
) {
  if (method === "POST" && url && /^\/invites\/(?:new|shared)\/?(?:\?|$)/.test(url)
    && headers.origin === "null" && headers.referer === undefined
    && headers["sec-fetch-site"] === "same-origin"
    && headers["sec-fetch-mode"] === "navigate" && headers["sec-fetch-dest"] === "document") {
    delete headers.origin;
  }
  next();
}
