import { and, eq, isNull, ne, or } from "drizzle-orm";
import { entries, entryMedia, media } from "./db/schema";
import { DELETED_MEMBER_ID } from "./deleted-member";

export function matchingMediaOwner() {
  return and(eq(entries.authorId, media.uploadedBy), ne(entries.authorId, DELETED_MEMBER_ID))!;
}

export function ownerMediaReference() {
  return or(eq(entryMedia.isOwnerReference, true), and(isNull(entryMedia.isOwnerReference), matchingMediaOwner()))!;
}
