ALTER TABLE "entry_media" ADD COLUMN "is_owner_reference" boolean;
--> statement-breakpoint
-- compat: Older application versions keep using the original columns and can omit the nullable ownership field when writing references.
UPDATE "entry_media" AS ref
SET "is_owner_reference" = entry."author_id" = image."uploaded_by"
FROM "entries" AS entry, "media" AS image
WHERE ref."entry_id" = entry."id" AND ref."media_id" = image."id";
