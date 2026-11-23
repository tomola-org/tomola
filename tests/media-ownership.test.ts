import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { deleteAccount } from "~/lib/account-delete.server";
import type { Db } from "~/lib/db/client.server";
import { entries, entryMedia, media, user } from "~/lib/db/schema";
import { DELETED_MEMBER_EMAIL, DELETED_MEMBER_ID } from "~/lib/deleted-member";
import { publicFigureCondition } from "~/lib/figure-translation.server";
import { canReadMedia, syncMediaReferences } from "~/lib/media-references.server";
import { readMedia, readMediaBatch } from "~/lib/media-store.server";
import { addMember, createTestDb } from "./helpers/db";

const owner = "image-owner", writer = "reply-writer", reader = "image-reader";
const image = "a".repeat(64);
const body = `![diagram](/media/${image}-1x1.webp)`;

async function fixture() {
  const db = await createTestDb();
  await addMember(db, owner, "image_owner");
  await addMember(db, writer, "reply_writer");
  await addMember(db, reader, "image_reader");
  await db.insert(media).values({ id: image, uploadedBy: owner, bytes: Buffer.from([1]), byteSize: 1, mime: "image/webp", width: 1, height: 1 });
  const [topic] = await db.insert(entries).values({ kind: "topic", body, lang: "en", authorId: owner }).returning({ id: entries.id });
  const [root] = await db.insert(entries).values({ kind: "topic", body: "Figure discussion", lang: "en", authorId: reader }).returning({ id: entries.id });
  const [reply] = await db.insert(entries).values({ kind: "reply", threadId: root.id, body, lang: "en", authorId: writer }).returning({ id: entries.id });
  return { db, topic: topic.id, reply: reply.id };
}

async function ownership(db: Db) {
  return (await db.select().from(entryMedia).orderBy(entryMedia.entryId)).map(row => row.isOwnerReference);
}

it("records original and quoted image references and withdraws unused bytes", async () => {
  const { db, topic, reply } = await fixture();
  await db.transaction(async tx => {
    await syncMediaReferences(tx, topic, body);
    await syncMediaReferences(tx, reply, body);
  });
  expect(await ownership(db)).toEqual([true, false]);
  await deleteAccount(db, owner, { confirmation: "image_owner", posts: "delete" });
  expect(await readMedia(db, image)).toBeNull();
  expect((await db.select({ bytes: media.bytes, deletedAt: media.deletedAt }).from(media))[0]).toEqual({ bytes: null, deletedAt: expect.any(Date) });
  expect(await canReadMedia(db, image, null)).toBe(false);
});

it("retains ownership and delivery for a preserved original image", async () => {
  const { db, topic } = await fixture();
  await db.transaction(tx => syncMediaReferences(tx, topic, body));
  await deleteAccount(db, owner, { confirmation: "image_owner", posts: "keep" });
  await db.transaction(tx => syncMediaReferences(tx, topic, body));
  expect(await ownership(db)).toEqual([true]);
  expect(await canReadMedia(db, image, null)).toBe(true);
  expect(await readMediaBatch(db, [image])).toMatchObject([{ id: image }]);
  expect(await db.select({ id: media.id }).from(media).where(publicFigureCondition(db))).toEqual([{ id: image }]);
});

it("requires a visible owner reference for public and member image delivery", async () => {
  const { db, topic, reply } = await fixture();
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topic));
  await db.transaction(async tx => {
    await syncMediaReferences(tx, topic, body);
    await syncMediaReferences(tx, reply, body);
  });
  await deleteAccount(db, owner, { confirmation: "image_owner", posts: "keep" });
  await deleteAccount(db, writer, { confirmation: "reply_writer", posts: "keep" });
  expect(await ownership(db)).toEqual([true, false]);
  expect(await readMedia(db, image)).toMatchObject({ bytes: Buffer.from([1]) });
  expect(await canReadMedia(db, image, null)).toBe(false);
  expect(await canReadMedia(db, image, { userId: reader, scope: { operator: false, langs: [] } })).toBe(false);
  expect(await readMediaBatch(db, [image])).toEqual([]);
  expect(await db.select({ id: media.id }).from(media).where(publicFigureCondition(db))).toEqual([]);
});

it("classifies legacy references during reads and records their ownership at departure", async () => {
  const { db, topic, reply } = await fixture();
  await db.insert(entryMedia).values({ entryId: reply, mediaId: image });
  expect(await canReadMedia(db, image, null)).toBe(false);
  await db.insert(entryMedia).values({ entryId: topic, mediaId: image });
  expect(await ownership(db)).toEqual([null, null]);
  expect(await canReadMedia(db, image, null)).toBe(true);
  await deleteAccount(db, owner, { confirmation: "image_owner", posts: "keep" });
  expect(await ownership(db)).toEqual([true, false]);
  expect(await canReadMedia(db, image, null)).toBe(true);
  await db.update(entryMedia).set({ isOwnerReference: null });
  expect(await canReadMedia(db, image, null)).toBe(false);
});

it("leaves legacy references with anonymized authors or uploaders ineligible", async () => {
  const { db, topic, reply } = await fixture();
  await db.insert(user).values({ id: DELETED_MEMBER_ID, name: "", email: DELETED_MEMBER_EMAIL });
  await db.insert(entryMedia).values([{ entryId: topic, mediaId: image }, { entryId: reply, mediaId: image }]);
  await db.update(entries).set({ authorId: DELETED_MEMBER_ID }).where(eq(entries.id, topic));
  expect(await canReadMedia(db, image, null)).toBe(false);
  await db.update(media).set({ uploadedBy: DELETED_MEMBER_ID }).where(eq(media.id, image));
  expect(await canReadMedia(db, image, null)).toBe(false);
});
