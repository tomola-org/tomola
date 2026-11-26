import { lazy, Suspense, useState, type ComponentProps } from "react";
import { QuietBoundary, usePageReady } from "~/components/quiet-boundary";
import type DraftAutosaveContent from "./draft-autosave-content";

const Content = lazy(() => import("./draft-autosave-content"));

// Autosave starts after the writing form is ready; its storage and recovery
// work need not enlarge the page's initial script.
export function DraftAutosave({ inline, notice, ...props }: Omit<ComponentProps<typeof DraftAutosaveContent>, "onSaveStatus"> & { inline?: boolean; notice?: string }) {
  const [saveStatus, setSaveStatus] = useState("");
  const label = saveStatus || notice;
  // Keep SSR free of a dehydrated autosave boundary: a delayed module must
  // not hold the departure guard's blocked-navigation effect during hydration.
  // Only the save that brought the writer here is announced; routine autosave progress stays silent.
  return <>
    {inline && <span className="min-w-0 flex-1 truncate ui-help text-muted-foreground" title={label}>
      <span role="status">{saveStatus ? "" : notice}</span>
      <span aria-live="off">{saveStatus}</span>
    </span>}
    {usePageReady() && <QuietBoundary><Suspense fallback={null}><Content {...props} onSaveStatus={inline ? setSaveStatus : undefined} /></Suspense></QuietBoundary>}
  </>;
}
