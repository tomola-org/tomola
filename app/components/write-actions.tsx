import { useEffect, useRef, type ReactNode } from "react";

export function WriteActions({ children, status }: { children: ReactNode; status?: ReactNode }) {
  const actions = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = actions.current;
    if (!row) return;
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const update = () => {
      root.style.setProperty("--write-actions-height", `${row.offsetHeight}px`);
      // Mobile keyboards can shrink the visual viewport without changing the CSS media query.
      const rem = Number.parseFloat(getComputedStyle(root).fontSize);
      row.toggleAttribute("data-write-actions-compact", (viewport?.height ?? window.innerHeight) < 32 * rem);
    };
    const observer = new ResizeObserver(update);
    observer.observe(row);
    viewport?.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      viewport?.removeEventListener("resize", update);
      root.style.removeProperty("--write-actions-height");
    };
  }, []);
  return <div ref={actions} data-write-actions="" className="space-y-2 rounded border bg-background p-2">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div>
    {status}
  </div>;
}
