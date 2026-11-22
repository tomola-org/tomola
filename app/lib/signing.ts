import type { LanguageDecision } from "~/lib/lang-detect";
import type { PublicVillage } from "~/lib/villages.server";

export type WriteOperation = "create-topic" | "create-reply" | "publish-draft" | "edit-topic" | "edit-reply" | "change-handle" | "change-display-name" | "remove-passkey" | "delete-account";
export type SigningContent = { title: string | null; body: string; lang: string | null };
export type SigningPreview = {
  village?: PublicVillage;
  content: SigningContent;
  language: LanguageDecision | null;
  viewed: SigningContent | null;
  current: SigningContent | null;
  target: { threadId: number | null; parentId: number | null; draftId: number | null; altOf: number | null; villageId?: string };
  lastEditor: { id: string | null; name: string | null; uri: string | null; at: string | null } | null;
  targetContext: { thread: SigningContent | null; parent: SigningContent | null };
  signatureRequired: false;
  confirmation?: string;
};
export const SIGNATURE_CHALLENGE_FIELD = "signatureChallenge";
export const SIGNATURE_ASSERTION_FIELD = "signatureAssertion";
export const SIGNING_VIEW_FIELD = "signingView";
export const DRAFT_CONFIRMATION_FIELD = "confirmation";

export function needsDraftConfirmation(draft: { via: string; clientKey: string | null; clientId: string | null }): boolean {
  return draft.via === "api" || draft.clientKey !== null || draft.clientId !== null;
}

export function isDraftConfirmationError(code: string | null | undefined): boolean {
  return code === "confirmation_required" || code === "confirmation_expired" || code === "confirmation_changed";
}
