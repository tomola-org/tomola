ALTER TABLE "entry_media" ADD COLUMN "is_owner_reference" boolean;
--> statement-breakpoint
-- compat: This update writes only the new nullable column, which older application versions neither read nor require when writing references.
UPDATE "entry_media" AS ref
SET "is_owner_reference" = entry."author_id" = image."uploaded_by"
FROM "entries" AS entry, "media" AS image
WHERE ref."entry_id" = entry."id" AND ref."media_id" = image."id";
