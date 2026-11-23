import { useLayoutEffect, useRef, useState } from "react";

// Reloads and history loads may restore an older textarea over newer server text.
// Other arrivals keep native edits, including clearing the field before hydration.
export function prehydrationBody(body: Pick<HTMLTextAreaElement, "value" | "defaultValue">, navigation: PerformanceNavigationTiming["type"] | undefined): string | undefined {
  return navigation !== "reload" && navigation !== "back_forward" && body.value !== body.defaultValue ? body.value : undefined;
}

export function usePrehydrationTextarea(id: string | undefined) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [early] = useState(() => {
    if (!id || typeof document === "undefined") return;
    const field = document.getElementById(id);
    if (!(field instanceof HTMLTextAreaElement)) return;
    const navigation = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
    const value = prehydrationBody(field, navigation);
    return value === undefined ? undefined : { field, value };
  });
  useLayoutEffect(() => {
    // React's reset and this effect must run synchronously during hydration.
    // A boundary that hydrates later can allow input between them.
    const field = ref.current;
    // The live value already uses LF; the default can still contain CRLF.
    if (field && field === early?.field && field.value === field.defaultValue.replace(/\r\n?/g, "\n")) field.value = early.value;
  }, [early]);
  return ref;
}
