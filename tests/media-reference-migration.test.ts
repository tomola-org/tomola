import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { migrationsFolder } from "~/lib/db/client.server";
import { PGLITE_EXTENSIONS } from "~/lib/db/pglite.server";
import { entries, entryMedia, media } from "~/lib/db/schema";
import { DELETED_MEMBER_EMAIL, DELETED_MEMBER_ID } from "~/lib/deleted-member";
import { addMember, createTestDb } from "./helpers/db";
import { migrationsBefore, migrationStatements } from "./helpers/migrations";

it("backfills existing original references once, including hidden and deleted posts", async () => {
  const db = await createTestDb();
  await addMember(db, "image_migration", "sec_image_migration");
  const id = "a".repeat(64), missing = "f".repeat(64);
  await db.insert(media).values({ id, bytes: Buffer.from("x"), mime: "image/webp", width: 1, height: 1, byteSize: 1, uploadedBy: "image_migration" });
  const path = `/media/${id}-1x1.webp`;
  await db.insert(entries).values([
    { kind: "topic", authorId: "image_migration", lang: "en", body: `![one](${path}) ![two](https://forum.example${path})`, hiddenAt: new Date() },
    { kind: "topic", authorId: "image_migration", lang: "en", body: `![deleted](${path})`, deletedAt: new Date() },
    { kind: "topic", authorId: "image_migration", lang: "en", body: `/media/${missing}-1x1.webp /media/${id}-0x1.webp` },
  ]);
  expect(await db.select().from(entryMedia)).toEqual([]);
  const backfill = migrationStatements("media_references").at(-1)!;
  await db.execute(sql.raw(backfill));
  await db.execute(sql.raw(backfill));
  const refs = await db.select().from(entryMedia);
  expect(refs).toHaveLength(2);
  expect(refs.every(row => row.mediaId === id)).toBe(true);
});

it("classifies existing references and accepts writes from older clients", { timeout: 60_000 }, async () => {
  const before = migrationsBefore("media_owner_reference");
  const client = new PGlite({ extensions: PGLITE_EXTENSIONS });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: before });
    await client.query(`insert into "user" (id, name, email) values
      ('migration-owner', '', 'owner@example.invalid'), ('migration-writer', '', 'writer@example.invalid'), ($1, '', $2)`,
    [DELETED_MEMBER_ID, DELETED_MEMBER_EMAIL]);
    const original = "b".repeat(64), retained = "c".repeat(64);
    await db.insert(media).values([
      { id: original, uploadedBy: "migration-owner" }, { id: retained, uploadedBy: DELETED_MEMBER_ID },
    ].map(image => ({ ...image, bytes: Buffer.from([1]), mime: "image/webp", width: 1, height: 1, byteSize: 1 })));
    const fixtures = [
      { authorId: "migration-owner", mediaId: original, owned: true },
      { authorId: "migration-writer", mediaId: original, owned: false },
      { authorId: DELETED_MEMBER_ID, mediaId: original, owned: false },
      { authorId: "migration-writer", mediaId: retained, owned: false },
      { authorId: DELETED_MEMBER_ID, mediaId: retained, owned: true },
    ];
    const posts = await db.insert(entries).values(fixtures.map(({ authorId, mediaId }) => ({
      kind: "topic", lang: "en", authorId, body: `![diagram](/media/${mediaId}-1x1.webp)`,
    }))).returning({ id: entries.id });
    for (const [index, { id }] of posts.entries()) {
      await client.query("insert into entry_media (entry_id, media_id) values ($1, $2)", [id, fixtures[index].mediaId]);
    }
    const countShared = () => client.query(`select count(*)::int as count from entry_media ref
      join entries e on e.id = ref.entry_id join media m on m.id = ref.media_id
      where e.author_id = $1 and m.uploaded_by = $1`, [DELETED_MEMBER_ID]);
    expect((await countShared()).rows).toEqual([{ count: 1 }]);
    const originalEntries = await db.select().from(entries).orderBy(entries.id);
    const originalMedia = await db.select().from(media).orderBy(media.id);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    expect(await db.select().from(entryMedia).orderBy(entryMedia.entryId)).toEqual(posts.map(({ id }, index) => ({
      entryId: id, mediaId: fixtures[index].mediaId, isOwnerReference: fixtures[index].owned,
    })));
    expect((await countShared()).rows).toEqual([{ count: 1 }]);
    expect(await db.select().from(entries).orderBy(entries.id)).toEqual(originalEntries);
    expect(await db.select().from(media).orderBy(media.id)).toEqual(originalMedia);
    await client.query("delete from entry_media where entry_id = $1", [posts[0].id]);
    await client.query("insert into entry_media (entry_id, media_id) values ($1, $2)", [posts[0].id, original]);
    expect((await db.select().from(entryMedia).orderBy(entryMedia.entryId))[0]).toEqual({
      entryId: posts[0].id, mediaId: original, isOwnerReference: null,
    });
  } finally {
    await client.close();
    fs.rmSync(before, { recursive: true, force: true });
  }
});
