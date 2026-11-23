import { Form, Link } from "react-router";
import { Button } from "~/components/ui/button";
import { loginMethodReauthenticationPath } from "~/lib/reauth";
import { withSettingsReturn } from "~/lib/settings-return";
import { m } from "~/paraglide/messages.js";

export function LoginMethodSettings({ login, googleAvailable, returnTo, error }: {
  login: { passkeyFresh: boolean; passkeyOnly: boolean; canEnable: boolean; remaining: { tokens: number; connections: number } };
  googleAvailable: boolean;
  returnTo?: string | null;
  error?: string;
}) {
  const path = withSettingsReturn("/settings#settings-login-methods", returnTo);
  const change = <Form method="post" action={path} reloadDocument>
    <input type="hidden" name="intent" value="passkey-only" />
    <input type="hidden" name="enabled" value={login.passkeyOnly ? "0" : "1"} />
    <Button type="submit" variant="outline">{login.passkeyOnly ? m.login_methods_disable() : m.login_methods_enable()}</Button>
  </Form>;
  const purpose = login.passkeyOnly ? "disable-passkey-only" : "enable-passkey-only";
  const control = login.passkeyFresh ? change : <Link to={loginMethodReauthenticationPath(path, purpose, "passkey")} className="underline">{m.login_methods_verify_passkey()}</Link>;
  const { tokens, connections } = login.remaining;
  return <section id="settings-login-methods" aria-labelledby="login-methods-heading" className="scroll-mt-4 space-y-3">
    <h3 id="login-methods-heading" className="text-lg font-semibold">{m.login_methods_title()}</h3>
    <p>{login.passkeyOnly ? m.login_methods_on() : m.login_methods_off()}</p>
    {error && <p role="alert" className="text-destructive">{error === "passkey_backup_required" ? m.login_methods_backup_required() : m.login_methods_update_failed()}</p>}
    {login.passkeyOnly ? control : <details className="space-y-2">
      <summary className="cursor-pointer">{m.login_methods_review()}</summary>
      <p className="ui-help text-muted-foreground">{m.login_methods_enable_help()}</p>
      <p className="ui-help text-muted-foreground">{m.login_methods_test_backup()}</p>
      {(tokens > 0 || connections > 0) && <ul className="list-disc ps-5 ui-help">
        {tokens > 0 && <li>{m.login_methods_api_remains({ count: tokens })}</li>}
        {connections > 0 && <li>{m.login_methods_mcp_remains({ count: connections })}</li>}
      </ul>}
      <p className="ui-help">{m.login_methods_ai_remains()}</p>
      {login.canEnable ? control : <p className="ui-help">{m.login_methods_backup_required()}</p>}
    </details>}
    <details className="space-y-2">
      <summary className="cursor-pointer">{m.login_methods_compromise()}</summary>
      <p className="ui-help text-muted-foreground">{m.login_methods_revoke_help()}</p>
      <p className="ui-help text-muted-foreground">{m.login_methods_revoke_pending()}</p>
      <p className="ui-help text-muted-foreground">{m.login_methods_revoke_keep()}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 ui-help">
        <li><Link to={withSettingsReturn("/settings#settings-passkeys", returnTo)} className="underline">{m.settings_passkeys_heading()}</Link></li>
        {googleAvailable && <li><Link to={withSettingsReturn("/settings#settings-google", returnTo)} className="underline">{m.google_settings_heading()}</Link></li>}
      </ul>
      <Form method="post" action={path} reloadDocument>
        <input type="hidden" name="intent" value="revoke-login-credentials" />
        <Button type="submit" variant="destructive">{m.login_methods_revoke()}</Button>
      </Form>
    </details>
  </section>;
}
