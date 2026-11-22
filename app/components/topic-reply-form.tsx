import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ReplyFields } from "~/components/reply-fields";
import { SendButton, EntryFormFrame } from "~/components/entry-form-frame";
import { afterPageIdle } from "~/lib/initial-activation";
import { m } from "~/paraglide/messages.js";

type Fields = ComponentProps<typeof ReplyFields>;
type EntryControls = typeof import("./entry-form-controls").default;
let loadedEntryControls: EntryControls | undefined;
type DeferredSubmit = { form: HTMLFormElement; submitter: HTMLElement | null; snapshot: string };
const replyIdentity = (values: FormData) => JSON.stringify([values.get("body"), values.get("parentId"), values.get("intent")]);

export default function TopicReplyForm({ respondWithPost, children, ...fields }: Pick<Fields,
  "nushiAvailable" | "owner" | "threadId" | "keeper" | "error" | "errorText" | "defaultLang" | "defaultBody" | "selectedLang" | "above" | "aiTools"
> & {
  respondWithPost: (ComponentProps<typeof SendButton> & { formAction: string }) | null;
  children: ReactNode;
}) {
  const [entryControls, setEntryControls] = useState<EntryControls | null | undefined>(() => loadedEntryControls);
  const loadStarted = useRef(entryControls !== undefined);
  const queuedSubmit = useRef<DeferredSubmit | null>(null);
  const prepareControls = useCallback(() => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    void import("./entry-form-controls").then(({ default: Controls }) => {
      loadedEntryControls = Controls;
      setEntryControls(() => Controls);
    }, () => setEntryControls(null));
  }, []);
  useEffect(() => entryControls === undefined ? afterPageIdle(prepareControls) : undefined, [prepareControls, entryControls]);
  useEffect(() => {
    if (entryControls === undefined) return;
    const queued = queuedSubmit.current;
    queuedSubmit.current = null;
    if (!queued?.form.isConnected || queued.submitter && !queued.form.contains(queued.submitter)) return;
    if (replyIdentity(new FormData(queued.form, queued.submitter)) === queued.snapshot) queued.form.requestSubmit(queued.submitter ?? undefined);
  }, [entryControls]);
  // Use router submissions after hydration so the draft keeper sees whether the server accepted the reply.
  return <EntryFormFrame controls={entryControls} protectUnsaved="new" preserveUnsavedOnSamePath
    method="post" className="space-y-2" onPointerOver={prepareControls} onFocusCapture={prepareControls} onSubmit={event => {
      if (entryControls !== undefined) return;
      const submitter = event.nativeEvent.submitter;
      const values = new FormData(event.currentTarget, submitter);
      if (values.get("intent")) return;
      // Send when the unsaved form guard is ready, provided the requested reply is unchanged.
      event.preventDefault();
      queuedSubmit.current = { form: event.currentTarget, submitter, snapshot: replyIdentity(values) };
      prepareControls();
    }}>
    {children}
    <ReplyFields
      {...fields}
      errorId="reply-error"
      actions={respondWithPost && <div className="flex flex-wrap gap-2">
        <SendButton>{m.submit_reply()}</SendButton>
        <SendButton {...respondWithPost} aria-describedby="respond-with-post-hint" />
        <p id="respond-with-post-hint" className="w-full ui-help text-muted-foreground">{m.respond_with_post_hint()}</p>
      </div>}
    />
  </EntryFormFrame>;
}
