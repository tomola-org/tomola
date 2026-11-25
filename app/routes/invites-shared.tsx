import { useEffect, useRef, useState } from "react";
import { data, Form, useNavigation } from "react-router";
import { InvitationLink } from "~/components/invitation-link";
import { InvitationTabs } from "~/components/invitation-tabs";
import { InvitationVillageSelect } from "~/components/invitation-village-select";
import { SharedInvitationsTable } from "~/components/shared-invitations-table";
import { Button } from "~/components/ui/button";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { requireMember, requirePrivilegedWriteSession, requireWriter } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { withMarkdownRead } from "~/lib/markdown-budget.server";
import { isOperatorEmail } from "~/lib/operators.server";
import { createSharedInvitation, listSharedInvitations, revokeSharedInvitation } from "~/lib/shared-invitations.server";
import { signupVillageChoices } from "~/lib/signup-village.server";
import { inviteUrl } from "~/lib/site-url";
import { m } from "~/paraglide/messages.js";
import type { Route } from "./+types/invites-shared";

export function headers() {
  return { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };
}

export function loader({ request }: Route.LoaderArgs) {
  return withMarkdownRead(async () => {
    const { db, user } = await requireMember(request);
    if (!isOperatorEmail(user.email)) throw data("Not found", { status: 404 });
    const sharedInvitations = await listSharedInvitations(db, { createdBy: user.id });
    const villages = await signupVillageChoices(db, user.id);
    return { sharedInvitations, villages };
  });
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { user, db } = await requireMember(request);
  if (!isOperatorEmail(user.email)) throw data("Not found", { status: 404 });
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent !== "create-shared" && intent !== "revoke-shared") throw data("Bad request", { status: 400 });
  if (intent === "create-shared") await requireWriter(request);
  await requirePrivilegedWriteSession(request);
  if (intent === "revoke-shared") {
    if (!await revokeSharedInvitation(db, String(form.get("id") ?? ""), user.id)) throw data("Not found", { status: 404 });
    return data(null, { headers: headers() });
  }
  const result = await createSharedInvitation(db, user, form);
  if (result.error === "forbidden") throw data("Not found", { status: 404 });
  if (result.error) return data({ sharedError: result.error }, { status: result.error === "rate_limited" ? 429 : 400, headers: headers() });
  return data({ sharedUrl: inviteUrl(result.token) }, { headers: headers() });
}

export function meta({}: Route.MetaArgs) {
  return [{ title: m.shared_invites_title() }];
}

export default function InvitesShared({ actionData, loaderData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement>(null);
  const [villageId, setVillageId] = useState("");
  const sharedUrl = actionData && "sharedUrl" in actionData ? actionData.sharedUrl : null;
  const sharedError = actionData && "sharedError" in actionData ? actionData.sharedError : null;
  useEffect(() => {
    if (sharedUrl) formRef.current?.reset();
  }, [sharedUrl]);
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{m.invites_title()}</h1>
      <InvitationTabs current="shared" />
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">{m.shared_invites_create()}</h2>
        <Form ref={formRef} method="post" onReset={() => setVillageId("")} className="space-y-2">
          <input type="hidden" name="intent" value="create-shared" />
          <Field><FieldLabel>{m.shared_invites_label()}
            <Input name="label" required maxLength={80} aria-describedby="shared-invitation-label-help" />
          </FieldLabel></Field>
          <p id="shared-invitation-label-help" className="ui-help text-muted-foreground">{m.shared_invites_label_help()}</p>
          <Field><FieldLabel>{m.shared_invites_max_uses()}
            <Input name="maxUses" type="number" required min={1} max={100} defaultValue={20} />
          </FieldLabel></Field>
          <Field><FieldLabel>{m.shared_invites_ttl()}
            <Input name="ttlDays" type="number" required min={1} max={30} defaultValue={14} />
          </FieldLabel></Field>
          <InvitationVillageSelect villages={loaderData.villages} value={villageId} onValueChange={setVillageId} />
          <Button type="submit" disabled={navigation.state !== "idle"}>{m.shared_invites_create()}</Button>
        </Form>
        {sharedError && <p role="alert" className="text-destructive">{sharedError === "rate_limited" ? m.shared_invites_rate_limited()
          : sharedError === "invalid_village" ? m.error_generic() : m.shared_invites_invalid()}</p>}
        {sharedUrl && <>
          <InvitationLink key={sharedUrl} url={sharedUrl} compact />
          <p className="ui-help text-muted-foreground">{m.invites_once()}</p>
        </>}
      </section>
      <section className="space-y-2">
        <h2 className="text-xl font-semibold">{m.shared_invites_title()}</h2>
        <SharedInvitationsTable rows={loaderData.sharedInvitations} />
      </section>
    </main>
  );
}
