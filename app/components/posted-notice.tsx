import { useEffect } from "react";
import { POST_NOTICE_PARAMS } from "~/lib/notice-params";

// Clean the address a few seconds after the notice appears so copied links omit it.
export function useDropNoticeParams(active: boolean, params: readonly string[] = POST_NOTICE_PARAMS) {
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      const url = new URL(window.location.href);
      if (!params.some(name => url.searchParams.has(name))) return;
      for (const name of params) url.searchParams.delete(name);
      window.history.replaceState(window.history.state, "", url);
    }, 6000);
    return () => clearTimeout(timer);
  }, [active, params]);
}
