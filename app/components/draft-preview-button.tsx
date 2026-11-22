import { useEffect, useRef, useState } from "react";
import { SendButton } from "~/components/signed-form-frame";
import { m } from "~/paraglide/messages.js";

export function DraftPreviewButton() {
  const anchor = useRef<HTMLSpanElement>(null);
  const [empty, setEmpty] = useState(false);
  useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    const refresh = () => {
      const title = form.elements.namedItem("title") as HTMLInputElement | null;
      const body = form.elements.namedItem("body") as HTMLTextAreaElement | null;
      setEmpty(!title?.value.trim() && !body?.value.trim());
    };
    refresh();
    form.addEventListener("input", refresh);
    form.addEventListener("change", refresh);
    const observer = new MutationObserver(refresh);
    observer.observe(form, { subtree: true, childList: true, attributes: true, attributeFilter: ["value"] });
    return () => {
      observer.disconnect();
      form.removeEventListener("input", refresh);
      form.removeEventListener("change", refresh);
    };
  }, []);
  return <span ref={anchor} data-draft-preview-button=""><SendButton intent="preview" variant="outline" disabled={empty} formNoValidate>{m.preview()}</SendButton></span>;
}
