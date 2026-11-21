import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";

export type InvitationRef = { kind: "individual"; id: string } | { kind: "shared"; id: string };

export function parseInvitationRef(value: unknown): InvitationRef | null {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)
    || !("kind" in value) || (value.kind !== "individual" && value.kind !== "shared")) return null;
  return { kind: value.kind, id: value.id };
}

export function sameInvitation(a: InvitationRef | null, b: InvitationRef | null) {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

export const magicLinkInvitationIdentifier = (token: string) => `magic-link-invite:${createHash("sha256").update(token).digest("base64url")}`;

// A present store with a null ref represents a malformed or expired binding.
export const magicLinkInvitationContext = new AsyncLocalStorage<{ ref: InvitationRef | null }>();

export function invitationRequired() {
  return new APIError("FORBIDDEN", { code: "INVITATION_REQUIRED", message: "invitation_required" });
}
