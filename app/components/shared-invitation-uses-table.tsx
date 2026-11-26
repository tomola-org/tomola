import { AuthorLink } from "~/components/author-link";
import { LocalTime } from "~/components/local-time";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import type { listSharedInvitationUses } from "~/lib/shared-invitations.server";
import { m } from "~/paraglide/messages.js";

type Rows = Awaited<ReturnType<typeof listSharedInvitationUses>>;

export function SharedInvitationUsesTable({ rows, limit, admin = false }: { rows: Rows; limit: number; admin?: boolean }) {
  return (
    <section className="space-y-2">
      <h2 className="text-xl font-semibold">{m.shared_invites_uses_title()}</h2>
      {rows.length === 0 ? <p>{m.shared_invites_uses_empty()}</p> : (
        <Table className="w-full text-start text-sm">
          <TableHeader>
            <TableRow>
              <TableHead>{m.shared_invites_col_member()}</TableHead>
              <TableHead>{m.shared_invites_col_link()}</TableHead>
              {admin && <TableHead>{m.admin_invitations_col_inviter()}</TableHead>}
              <TableHead>{m.shared_invites_col_registered_at()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(row => <TableRow key={row.id} className="align-top">
              <TableCell>
                {row.usedByHandle ? <AuthorLink handle={row.usedByHandle} /> : row.usedByExists
                  ? m.admin_invitations_used_by_no_profile()
                  : m.account_delete_member()}
              </TableCell>
              <TableCell className="whitespace-normal break-words"><span className="block min-w-32">{row.label}</span></TableCell>
              {admin && <TableCell>{row.inviterHandle ? `@${row.inviterHandle}` : m.admin_invitations_inviter_none()}</TableCell>}
              <TableCell><LocalTime iso={row.usedAt.toISOString()} /></TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      )}
      {rows.length >= limit && <p className="ui-help text-muted-foreground">{m.admin_invitations_limit({ count: limit })}</p>}
    </section>
  );
}
