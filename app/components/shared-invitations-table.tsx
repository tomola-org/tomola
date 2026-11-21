import { Form } from "react-router";
import { Button } from "~/components/ui/button";
import { LocalTime } from "~/components/local-time";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import type { listSharedInvitations } from "~/lib/shared-invitations.server";
import { m } from "~/paraglide/messages.js";

type Rows = Awaited<ReturnType<typeof listSharedInvitations>>;

export function SharedInvitationsTable({ rows, admin = false }: { rows: Rows; admin?: boolean }) {
  if (rows.length === 0) return <p>{m.shared_invites_empty()}</p>;
  const status = { valid: m.admin_invitations_status_valid, full: m.shared_invites_status_full,
    expired: m.admin_invitations_status_expired, revoked: m.invites_revoked };
  return (
    <div className="overflow-x-auto">
      <Table className="w-full text-start text-sm">
        <TableHeader>
          <TableRow>
            <TableHead>{m.shared_invites_label()}</TableHead>
            {admin && <TableHead>{m.admin_invitations_col_inviter()}</TableHead>}
            <TableHead>{m.invites_village()}</TableHead>
            <TableHead>{m.shared_invites_usage()}</TableHead>
            {admin && <TableHead>{m.shared_invites_created_at()}</TableHead>}
            <TableHead>{m.shared_invites_expires_at()}</TableHead>
            <TableHead>{m.admin_invitations_col_status()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(row => <TableRow key={row.id} className="align-top">
            <TableCell className="whitespace-normal break-words">{row.label}</TableCell>
            {admin && <TableCell>{row.inviterHandle ? `@${row.inviterHandle}` : m.admin_invitations_inviter_none()}</TableCell>}
            <TableCell className="whitespace-normal break-words">{row.villageName ?? "—"}</TableCell>
            <TableCell>{row.usedCount} / {row.maxUses}</TableCell>
            {admin && <TableCell><LocalTime iso={row.createdAt.toISOString()} /></TableCell>}
            <TableCell><LocalTime iso={row.expiresAt.toISOString()} /></TableCell>
            <TableCell>
              {status[row.status]()}
              {row.status === "valid" && <Form method="post">
                <input type="hidden" name="intent" value="revoke-shared" />
                <input type="hidden" name="id" value={row.id} />
                <Button type="submit" variant="outline">{m.invites_revoke()}</Button>
              </Form>}
            </TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </div>
  );
}
