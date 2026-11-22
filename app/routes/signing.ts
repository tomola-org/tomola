import type { Route } from "./+types/signing";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { previewDraftPublication, SigningError, signingErrorResponse } from "~/lib/signing.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { MarkdownBusyError } from "~/lib/markdown-budget.server";
import { SIGNATURE_ASSERTION_FIELD, SIGNATURE_CHALLENGE_FIELD } from "~/lib/signing";
import { MAX_BODY_BYTES } from "~/lib/body-length";

export function loader() { return new Response("Method not allowed", { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } }); }
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { db, user } = await requireMember(request);
  const rate = await hitMemberLimit(db, "signing", user.id);
  if (!rate.allowed) return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...rateLimitHeaders(rate), "Cache-Control": "private, no-store" } });
  try {
    const body = await request.json() as { intent?: unknown; pathname?: unknown; fields?: unknown };
    if (body.intent === "challenge") throw new SigningError("signing_closed", 409);
    if (body.intent !== "preview" || typeof body.pathname !== "string" || !Array.isArray(body.fields) || body.fields.length > 100) throw new SigningError("invalid_payload", 400);
    const form = new FormData();
    for (const pair of body.fields) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || pair[0].length > 100) throw new SigningError("invalid_payload", 400);
      const [name, value] = pair;
      if (name === SIGNATURE_CHALLENGE_FIELD || name === SIGNATURE_ASSERTION_FIELD) continue;
      if (typeof value !== "string" || value.length > MAX_BODY_BYTES) throw new SigningError("invalid_payload", 400);
      form.append(name, value);
    }
    await requireWriter(request);
    const result = await previewDraftPublication(db, user.id, body.pathname, form);
    return Response.json(result, { headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) {
    if (error instanceof MarkdownBusyError) return Response.json({ error: "rate_limited" }, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    if (error instanceof SigningError) return signingErrorResponse(error);
    if (error instanceof SyntaxError) return Response.json({ error: "invalid_payload" }, { status: 400 });
    throw error;
  }
}
