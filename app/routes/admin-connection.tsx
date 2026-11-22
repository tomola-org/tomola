import { data } from "react-router";
import type { Route } from "./+types/admin-connection";
import { getSessionUser, requireOperator } from "~/lib/auth/session.server";
import { clientAddress, forwardedForEntries, trustedProxyHops } from "~/lib/http/client-ip.server";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { isOperatorEmail } from "~/lib/operators.server";
import { m } from "~/paraglide/messages.js";

const diagnosticHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export const middleware: Route.MiddlewareFunction[] = [privateCacheMiddleware, async ({ request }, next) => {
  // Check before the member layout can redirect visitors to sign in.
  const user = await getSessionUser(request);
  if (!user || !isOperatorEmail(user.email)) throw new Response("Not found", { status: 404, headers: diagnosticHeaders });
  return next();
}];

export function headers() { return diagnosticHeaders; }
export function meta() { return [{ title: m.nav_connection() }]; }

export async function loader({ request }: Route.LoaderArgs) {
  await requireOperator(request);
  const hops = trustedProxyHops();
  const forwardedCount = forwardedForEntries(request.headers).length;
  const { protocol, host } = new URL(request.url);
  return data({
    address: clientAddress(request, { hops }),
    forwardedCount,
    hops,
    protocol,
    host,
    shortChain: forwardedCount < hops,
  }, { headers: diagnosticHeaders });
}

export default function AdminConnection({ loaderData }: Route.ComponentProps) {
  const { address, forwardedCount, hops, protocol, host, shortChain } = loaderData;
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{m.nav_connection()}</h1>
      {shortChain && <p className="font-medium">{m.admin_connection_short_chain()}</p>}
      {protocol === "http:" && <p className="font-medium">{m.admin_connection_http()}</p>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt>{m.admin_connection_address()}</dt>
        <dd className="break-all"><code>{address ?? "—"}</code></dd>
        <dt>{m.admin_connection_forwarded_count()}</dt>
        <dd><code>{forwardedCount}</code></dd>
        <dt><code>TRUSTED_PROXY_HOPS</code></dt>
        <dd><code>{hops}</code></dd>
        <dt>{m.admin_connection_protocol()}</dt>
        <dd><code>{protocol}</code></dd>
        <dt>Host</dt>
        <dd className="break-all"><code>{host}</code></dd>
      </dl>
    </main>
  );
}
