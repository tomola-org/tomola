import { useState, useSyncExternalStore } from "react";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { m } from "~/paraglide/messages.js";

const subscribe = () => () => {};
const clientSnapshot = () => typeof navigator.share === "function";
const serverSnapshot = () => false;

export function InvitationLink({ url, compact = false }: { url: string; compact?: boolean }) {
  const [notice, setNotice] = useState<"copied" | "message_copied" | "failed" | null>(null);
  // The share sheet is offered only where the browser has one (mostly phones), after hydration.
  const canShare = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const message = m.invites_message({ url });
  async function copy(text: string, done: "copied" | "message_copied") {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(done);
    } catch {
      setNotice("failed");
    }
  }
  async function share() {
    try { await navigator.share({ text: message }); } catch { /* Closing the share sheet is not an error. */ }
  }
  return (
    <div className="space-y-3">
      <p>{m.invites_created()} <code className="break-all">{url}</code></p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => void copy(url, "copied")} variant="outline">{m.invites_copy()}</Button>
      </div>
      {!compact && <div className="space-y-2">
        <label htmlFor="invitation-message" className="block ui-meta text-muted-foreground">{m.invites_message_label()}</label>
        <Textarea id="invitation-message" readOnly rows={4} value={message} className="block w-full text-sm" />
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void copy(message, "message_copied")} variant="outline">{m.invites_copy_message()}</Button>
          {canShare && <Button type="button" onClick={() => void share()} variant="outline">{m.invites_share()}</Button>}
        </div>
      </div>}
      {notice && <p role="status">{notice === "copied" ? m.invites_copied() : notice === "message_copied" ? m.invites_message_copied() : m.invites_copy_failed()}</p>}
    </div>
  );
}
