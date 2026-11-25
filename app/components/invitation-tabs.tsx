import { Link } from "react-router";
import { m } from "~/paraglide/messages.js";

export function InvitationTabs({ current }: { current: "email" | "shared" }) {
  return <nav aria-label={m.invites_title()} className="flex flex-wrap items-center gap-x-4 gap-y-1 ui-help">
    <Link to="/invites/new" aria-current={current === "email" ? "page" : undefined} className="choice">{m.invites_by_email()}</Link>
    <Link to="/invites/shared" aria-current={current === "shared" ? "page" : undefined} className="choice">{m.shared_invites_title()}</Link>
  </nav>;
}
