import { PersistentDetails } from "~/components/persistent-details";
import type { SigningPreview } from "~/lib/signing";
import { m } from "~/paraglide/messages.js";

export function SigningLastEditor({ editor }: { editor: SigningPreview["lastEditor"] }) {
  return editor?.id ? <>
    <p>{m.signing_last_ai({ name: editor.name ?? editor.id, id: editor.id, at: editor.at ?? "" })}</p>
    <p className="ui-help text-notice-emphasis">{m.signing_client_warning()}</p>
  </> : null;
}

export function SigningChanges({ preview }: { preview: Pick<SigningPreview, "viewed" | "current" | "content"> }) {
  const { viewed, current, content } = preview;
  const latest = current ?? content;
  return <>
    {viewed && <PersistentDetails open={latest.body !== viewed.body || latest.title !== viewed.title}>
      <summary>{m.signing_changes()}</summary>
      <Comparison before={viewed.body} after={latest.body} />
      {viewed.title !== latest.title && <p>{m.signing_title_change({ before: viewed.title ?? "", after: latest.title ?? "" })}</p>}
    </PersistentDetails>}
    {current && (current.body !== content.body || current.title !== content.title) && <PersistentDetails open>
      <summary>{m.signing_edit_changes()}</summary>
      <Comparison before={current.body} after={content.body} />
      {current.title !== content.title && <p>{m.signing_title_change({ before: current.title ?? "", after: content.title ?? "" })}</p>}
    </PersistentDetails>}
  </>;
}
function Comparison({ before, after }: { before: string; after: string }) {
  const original = before.split("\n"); const latest = after.split("\n");
  let start = 0; while (start < original.length && start < latest.length && original[start] === latest[start]) start++;
  let end = 0; while (end < original.length - start && end < latest.length - start && original[original.length - end - 1] === latest[latest.length - end - 1]) end++;
  if (start === original.length && start === latest.length) return <p>{m.signing_unchanged()}</p>;
  return <div className="space-y-2"><pre dir="auto" className="whitespace-pre-wrap break-words border-s-4 border-destructive p-2">{original.slice(start, original.length - end).map(line => `− ${line}`).join("\n")}</pre><pre dir="auto" className="whitespace-pre-wrap break-words border-s-4 border-success p-2">{latest.slice(start, latest.length - end).map(line => `+ ${line}`).join("\n")}</pre></div>;
}
