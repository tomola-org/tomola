import { useState } from "react";
import { useLocation, useNavigation } from "react-router";
import { REAUTH_RETURN_PARAM } from "~/lib/notice-params";
import { m } from "~/paraglide/messages.js";
import { useDropNoticeParams } from "./posted-notice";

const params = [REAUTH_RETURN_PARAM];

export function ReauthReturnNotice() {
  const { search, key } = useLocation();
  const submitting = useNavigation().state === "submitting";
  const marked = new URLSearchParams(search).get(REAUTH_RETURN_PARAM) === "1";
  const [dismissed, setDismissed] = useState(false);
  if (marked && submitting && !dismissed) setDismissed(true);
  useDropNoticeParams(marked, params, key);
  return marked && !dismissed ? <p role="status" className="mb-4 rounded border border-notice-border bg-notice-soft px-3 py-2 text-notice-foreground">{m.reauth_action_pending()}</p> : null;
}
