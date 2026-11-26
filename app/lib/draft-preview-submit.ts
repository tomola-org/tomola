import { data, isRouteErrorResponse } from "react-router";
import type { SigningContent } from "~/lib/signing";
import { captureDraftPreviewPosition, rememberDraftPreviewPosition } from "~/lib/draft-preview-position";

let previousView: { path: string; content: SigningContent } | undefined;

// The preceding view is only for the comparison in this tab. Publication
// verifies a separate, server-issued token for the version on the preview.
function rememberPreviousView(response: Response, form: FormData) {
  const path = response.headers.get("Location");
  const draft = path && /^\/drafts\/(\d+)\/preview$/.exec(path);
  const token = form.get("signingView");
  previousView = undefined;
  if (!draft || form.get("intent") !== "preview" || typeof token !== "string") return;
  try {
    const bytes = Uint8Array.from(atob(token.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
    const { id, title, body, lang } = JSON.parse(new TextDecoder().decode(bytes));
    if (String(id) === draft[1] && (title === null || typeof title === "string") && typeof body === "string" && typeof lang === "string") {
      previousView = { path: path!, content: { title, body, lang } };
    }
  } catch { /* An unavailable basis leaves the server-supplied comparison in place. */ }
}

export function previousDraftView(id: number): SigningContent | null {
  return previousView?.path === `/drafts/${id}/preview` ? previousView.content : null;
}

export function clearPreviousDraftView(id: number) {
  if (previousDraftView(id)) previousView = undefined;
}

export async function submitDraftPreview<T, F>(request: Request, serverAction: () => Promise<T>, blocked: F) {
  const retained = request.clone();
  const position = captureDraftPreviewPosition();
  try {
    return await serverAction();
  } catch (error) {
    if (request.signal.aborted || isRouteErrorResponse(error)) throw error;
    if (error instanceof Response) {
      const path = error.headers.get("Location");
      if (path && /^\/drafts\/\d+\/preview$/.test(path)) {
        const form = await retained.formData();
        rememberPreviousView(error, form);
        if (form.get("intent") === "preview" && !request.signal.aborted) rememberDraftPreviewPosition(path, position);
      }
      throw error;
    }
    if ((await retained.formData()).get("intent") !== "preview") throw error;
    return data(blocked, { status: 503 });
  }
}
