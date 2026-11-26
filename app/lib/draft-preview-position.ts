import { useLayoutEffect, type RefObject } from "react";
import { useLocation, useNavigationType } from "react-router";

type BodyPosition = { fraction: number; offset: number };
type PreviewReturn = { path: string; sourceKey: string; previewKey?: string; position: BodyPosition };

// The current preview has one return position in this tab. Keep only geometry,
// and tie it to the history entries that belong to that preview.
const storageKey = "tomola:draft-preview-position";
let pending: PreviewReturn | undefined;

function readPending() {
  if (!pending) {
    try {
      const saved: PreviewReturn | null = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (Number.isFinite(saved?.position?.fraction) && Number.isFinite(saved?.position?.offset)) pending = saved ?? undefined;
    } catch { /* Storage can be unavailable. */ }
  }
  return pending;
}

function setPending(saved: PreviewReturn | undefined) {
  pending = saved;
  try {
    if (saved) sessionStorage.setItem(storageKey, JSON.stringify(saved));
    else sessionStorage.removeItem(storageKey);
  } catch { /* Keep the in-memory behavior when storage is unavailable. */ }
}

function editorBody(container: Element | null | undefined) {
  return container?.querySelector<HTMLElement>(
    '[data-rich-editor-active="true"] [contenteditable="true"][role="textbox"], [data-rich-editor-active="false"] textarea[name="body"]',
  );
}

export function captureDraftPreviewPosition() {
  const source = { sourceKey: window.history.state?.key ?? "default", sourcePath: window.location.pathname };
  const body = editorBody(document.querySelector("form:has([data-draft-preview-button])"));
  const { top, height } = body?.getBoundingClientRect() ?? { top: 0, height: 0 };
  if (!height) return { ...source, position: undefined };
  const fraction = Math.max(0, Math.min(1, -top / height));
  return { ...source, position: { fraction, offset: -top - fraction * height } };
}

export function rememberDraftPreviewPosition(path: string, captured: ReturnType<typeof captureDraftPreviewPosition>) {
  if (captured.sourceKey !== (window.history.state?.key ?? "default") || captured.sourcePath !== window.location.pathname) return;
  const editPath = path.slice(0, -"/preview".length);
  // After the first save, Back should reopen the saved draft in place of
  // the now-completed new-topic entry. The router will push the preview.
  if (window.location.pathname === "/t/new") window.history.replaceState(window.history.state, "", editPath);
  setPending(captured.position ? { path, sourceKey: captured.sourceKey, position: captured.position } : undefined);
}

export function useDraftPreviewBackState(id: number) {
  const { key } = useLocation();
  useLayoutEffect(() => {
    const saved = readPending();
    if (saved?.path === `/drafts/${id}/preview` && !saved.previewKey) setPending({ ...saved, previewKey: key });
  }, [id, key]);
  return { draftPreviewReturn: key };
}

export function useRestoreDraftPreviewPosition(main: RefObject<HTMLElement | null>, id: number) {
  const location = useLocation();
  const navigation = useNavigationType();
  useLayoutEffect(() => {
    const saved = readPending();
    const container = main.current;
    if (!container || !saved?.previewKey || saved.path !== `/drafts/${id}/preview`) return;
    const returning = navigation === "POP"
      ? location.key === saved.sourceKey
      : location.state?.draftPreviewReturn === saved.previewKey;
    if (!returning) return;

    let frame: number | undefined;
    const restoreWhenReady = () => {
      if (frame !== undefined || !container.querySelector('[data-long-form-ready="true"]')) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const body = editorBody(container);
        if (!body || pending !== saved) return;
        const { top, height } = body.getBoundingClientRect();
        const { fraction, offset } = saved.position;
        window.scrollTo({ top: window.scrollY + top + fraction * height + offset, behavior: "instant" });
        setPending(undefined);
        observer.disconnect();
      });
    };
    const observer = new MutationObserver(restoreWhenReady);
    observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-long-form-ready"] });
    restoreWhenReady();
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [main, id, location.key, location.state, navigation]);
}
