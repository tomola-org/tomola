export type Reauthentication = "1" | "moderation";

export function isReauthentication(value: unknown): value is Reauthentication {
  return value === "1" || value === "moderation";
}

// Re-verify a signed-in member and return to a local path, which the login route validates.
export function reauthenticationPath(next: string, reauth: Reauthentication = "1"): string {
  return `/login?${new URLSearchParams({ reauth, next })}`;
}

const loginMethodPurposes = ["add-passkey", "remove-passkey", "enable-passkey-only", "disable-passkey-only", "revoke-all", "connect-google", "disconnect-google"] as const;
export type LoginMethodPurpose = typeof loginMethodPurposes[number];

export function loginMethodPurpose(value: string | null): LoginMethodPurpose | undefined {
  return loginMethodPurposes.find(purpose => purpose === value);
}

export function loginMethodReauthenticationPath(next: string, purpose: LoginMethodPurpose | undefined, method?: "passkey" | "remaining"): string {
  const params = new URLSearchParams({ reauth: "1", next });
  if (purpose) params.set("purpose", purpose);
  if (method) params.set("method", method);
  return `/login?${params}`;
}

export function isLoginMethodReturn(next: string): boolean {
  const url = new URL(next, "https://return.invalid");
  const continuation = url.searchParams.get("passkey");
  if (url.pathname === "/") return continuation === "continue";
  return url.pathname === "/settings" && (/^#settings-(?:login(?:-methods)?|passkeys|google)$/.test(url.hash)
    || continuation === "continue" || continuation === "continue-settings");
}
