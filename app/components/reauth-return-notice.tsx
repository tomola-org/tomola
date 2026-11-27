import { useLocation } from "react-router";
import { REAUTH_RETURN_PARAM } from "~/lib/notice-params";
import { m } from "~/paraglide/messages.js";
import { useDropNoticeParams } from "./posted-notice";

const params = [REAUTH_RETURN_PARAM];

export function ReauthReturnNotice() {
  const active = new URLSearchParams(useLocation().search).get(REAUTH_RETURN_PARAM) === "1";
  useDropNoticeParams(active, params);
  return active ? <p role="status" className="mb-4 rounded border border-notice-border bg-notice-soft px-3 py-2 text-notice-foreground">{m.reauth_action_pending()}</p> : null;
}
