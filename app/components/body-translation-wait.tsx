import { useEffect, useEffectEvent, useState } from "react";
import { useLocation, useRevalidator } from "react-router";
import { PendingText } from "~/components/pending-text";
import { BODY_TRANSLATION_POLL_MIN_MS, BODY_TRANSLATION_WAIT_MS, bodyTranslationPollDelay } from "~/lib/body-translation-poll";
import { languageLabel } from "~/lib/language-label";
import type { Lang, SourceLang } from "~/lib/languages";
import { topicPageKey } from "~/lib/topic-page";
import { useTranslationWait } from "~/lib/translation-wait";
import { m } from "~/paraglide/messages.js";

type State = "idle" | "working" | "stopped" | "unavailable" | "finished";
type Listener = { state: (value: State) => void; refresh: () => Promise<void>; target?: Lang };
type Status = { stopped: boolean; paused: number[]; ready: number[]; unavailable: number[] };
type Batch = {
  page: string;
  listeners: Map<number, Listener>;
  requested: Set<number>;
  controller: AbortController;
  until: number;
  round: number;
  inFlight: boolean;
  lastStartedAt: number;
  removeVisibilityListener: () => void;
  timer?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
};

// One coordinator per mounted topic page. Replies and the topic share each request.
let batch: Batch | undefined;
const pageAddress = () => topicPageKey(location.pathname, location.search);
const isCurrent = (current: Batch) => batch === current && !current.controller.signal.aborted;

function stop(current: Batch) {
  clearTimeout(current.timer);
  clearTimeout(current.deadline);
  current.removeVisibilityListener();
  current.controller.abort();
  if (batch === current) batch = undefined;
}

function finish(current: Batch) {
  for (const listener of current.listeners.values()) listener.state("stopped");
  current.listeners.clear();
  stop(current);
}

async function refresh(current: Batch, result: Status) {
  const settled = [...result.ready, ...result.unavailable];
  const ready = result.ready.map(id => current.listeners.get(id)).filter(listener => listener !== undefined);
  const listener = ready[0] ?? result.unavailable.map(id => current.listeners.get(id)).find(Boolean);
  if (!listener) return;
  const topicId = result.ready.find(id => current.listeners.get(id)?.target);
  const target = topicId === undefined ? undefined : current.listeners.get(topicId)?.target;

  // Revalidation preserves navigation and drafts. Anchor the first visible post
  // as the translation can change the height of posts above it.
  const anchor = [...document.querySelectorAll("article[id]")].find(post => post.getBoundingClientRect().bottom > 0);
  const top = anchor?.getBoundingClientRect().top;
  for (const id of result.unavailable) current.listeners.get(id)?.state("unavailable");
  for (const id of settled) current.listeners.delete(id);
  try {
    await listener.refresh();
  } catch {
    for (const listener of ready) listener.state("stopped");
    return;
  }
  for (const listener of ready) listener.state("finished");
  if (pageAddress() !== current.page) return;
  if (anchor && top !== undefined) {
    const replacement = document.getElementById(anchor.id);
    if (replacement) window.scrollBy(0, replacement.getBoundingClientRect().top - top);
  }
  if (ready.length) {
    const status = document.createElement("span");
    status.className = "sr-only";
    status.setAttribute("role", "status");
    document.body.append(status);
    setTimeout(() => {
      if (pageAddress() !== current.page) return;
      if (topicId !== undefined) {
        const body = document.getElementById(`p-${topicId}`)?.querySelector("[data-reading-body]");
        if (body?.getAttribute("lang") === target) status.textContent = m.translation_article_arrived();
      } else {
        status.textContent = m.translation_arrived();
      }
    }, 100);
    setTimeout(() => status.remove(), 3000);
  }
}

async function requestTranslations(current: Batch) {
  const { signal } = current.controller;
  const ids = [...current.listeners.keys()];
  const fresh = ids.filter(id => !current.requested.has(id));
  current.round++;
  try {
    current.lastStartedAt = Date.now();
    const response = await fetch(`${location.pathname}/translations${location.search}`, {
      method: "POST", credentials: "same-origin", redirect: "error", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: fresh.length ? "request" : "status", ids: fresh.length ? fresh : ids }),
    });
    if (!isCurrent(current) || pageAddress() !== current.page) return;
    if (!response.ok) { finish(current); return; }
    const result = await response.json() as Status;
    if (!isCurrent(current) || pageAddress() !== current.page) return;
    for (const id of result.paused ?? []) {
      current.listeners.get(id)?.state("stopped");
      current.listeners.delete(id);
    }
    const update = refresh(current, result);
    if (result.stopped) finish(current);
    else for (const id of fresh) {
      current.requested.add(id);
      current.listeners.get(id)?.state("working");
    }
    await update;
  } catch {
    // Retry an interrupted request on the same bounded schedule.
  }
}

function schedule(current: Batch, delay: number) {
  clearTimeout(current.timer);
  current.timer = setTimeout(() => { void poll(current); }, delay);
}

function onVisibilityChange(current: Batch) {
  if (!isCurrent(current) || !current.listeners.size) return;
  if (document.visibilityState !== "visible") {
    clearTimeout(current.timer);
    return;
  }
  const now = Date.now();
  const remaining = current.until - now;
  if (remaining <= 0) { finish(current); return; }
  if (current.inFlight) return;
  const delay = Math.max(0, BODY_TRANSLATION_POLL_MIN_MS - (now - current.lastStartedAt));
  schedule(current, Math.min(remaining, delay));
}

async function poll(current: Batch) {
  if (!isCurrent(current) || !current.listeners.size || current.inFlight || document.visibilityState !== "visible") return;
  const now = Date.now();
  if (now >= current.until) { finish(current); return; }
  if (current.until === Number.POSITIVE_INFINITY) {
    current.until = now + BODY_TRANSLATION_WAIT_MS;
    current.deadline = setTimeout(() => finish(current), BODY_TRANSLATION_WAIT_MS);
  }
  // A history traversal can change the address before the loader commits.
  if (pageAddress() === current.page) {
    current.inFlight = true;
    try {
      await requestTranslations(current);
    } finally {
      current.inFlight = false;
    }
  }

  if (!isCurrent(current)) return;
  if (!current.listeners.size) { stop(current); return; }
  if (document.visibilityState === "visible") {
    const round = Math.max(0, current.round - 1);
    schedule(current, bodyTranslationPollDelay(round, current.until - Date.now()));
  }
}

function join(page: string, entryId: number, listener: Listener): () => void {
  if (batch?.page !== page) {
    // A background tab has not begun its wait until the first visible check.
    const visibilityChanged = () => onVisibilityChange(current);
    const current: Batch = {
      page, listeners: new Map(), requested: new Set(), controller: new AbortController(),
      until: Number.POSITIVE_INFINITY, round: 0, inFlight: false, lastStartedAt: Number.NEGATIVE_INFINITY,
      removeVisibilityListener: () => document.removeEventListener("visibilitychange", visibilityChanged),
    };
    batch = current;
    document.addEventListener("visibilitychange", visibilityChanged);
    if (document.visibilityState === "visible") schedule(current, 0);
  }
  const current = batch;
  current.listeners.set(entryId, listener);
  return () => {
    if (current.listeners.get(entryId) === listener) current.listeners.delete(entryId);
    if (!current.listeners.size) stop(current);
  };
}

type OriginalNotice = { source: SourceLang; sourceCode?: string | null; target: Lang; long: boolean };

export default function BodyTranslationWait({ entryId, original }: { entryId: number; original?: OriginalNotice }) {
  const wait = useTranslationWait("posts");
  const [state, setState] = useState<State>("idle");
  const { pathname, search } = useLocation();
  const page = topicPageKey(pathname, search);
  const revalidator = useRevalidator();
  const refresh = useEffectEvent(async () => { await revalidator.revalidate(); });
  const target = original?.target;
  useEffect(() => {
    if (wait.kind === "stopped") return;
    setState("idle");
    return join(page, entryId, { state: setState, refresh, target });
  }, [page, entryId, wait.kind, target]);

  const shownState = wait.kind === "stopped" && state !== "unavailable" ? "stopped" : state;
  if (shownState === "finished") return null;
  const message = shownState === "stopped" ? m.label_no_translation() : shownState === "unavailable" ? m.translation_unavailable() : null;
  if (original) return (
    <div role="status" className={shownState === "idle" ? "sr-only" : "rounded border border-notice-border bg-notice-soft px-3 py-2 ui-help text-notice-foreground"}>
      {message}
      {shownState === "working" && <>
        <p data-article-translation-waiting="" className="font-semibold">
          <span aria-hidden="true" className="me-2 inline-block size-2 rounded-full bg-current motion-safe:animate-pulse" />
          {m.translation_article_working({ target: languageLabel(original.target) })}
        </p>
        <p>{m.translation_article_original({ source: languageLabel(original.source, original.sourceCode) })}</p>
        {original.long && <p>{m.translation_article_long()}</p>}
      </>}
    </div>
  );
  if (shownState === "idle") return <PendingText short />;
  return <span role="status" className="ui-meta text-muted-foreground">{message ?? <><span aria-hidden="true">{m.translation_working()}</span><span className="sr-only">{m.translation_working_accessible()}</span></>}</span>;
}
