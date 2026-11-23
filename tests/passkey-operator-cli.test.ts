import { beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { runPasskeyOperatorCli } from "../scripts/recover-passkeys";
import type { Db } from "~/lib/db/client.server";
import { account, jobs, passkey, passkeyRecoveryPermits, profiles } from "~/lib/db/schema";
import { SEND_PASSKEY_NOTICE_JOB } from "~/lib/jobs/mail-kinds";
import { addMember, createTestDb } from "./helpers/db";
import { signingCredential } from "./helpers/signing";

const operator = "passkey-operator@example.com";
const member = "managed-member@example.com";
const protectedMember = "protected-member@example.com";
const note = "Member requested a credential change";
let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  for (const id of ["passkey-operator", "managed-member", "protected-member"]) await addMember(db, id, id.replaceAll("-", "_"));
  await db.update(profiles).set({ passkeyOnly: true }).where(eq(profiles.userId, "protected-member"));
});

async function run(...args: string[]) {
  const log = vi.fn<(text: string) => void>();
  const error = vi.fn<(text: string) => void>();
  const openDb = vi.fn(async () => db);
  vi.stubEnv("OPERATOR_EMAILS", operator);
  try {
    const status = await runPasskeyOperatorCli(args, openDb, { log, error, warn: vi.fn(), write: vi.fn() });
    return { status, output: log.mock.calls.map(([line]) => line), errors: error.mock.calls.map(([line]) => line), opened: openDb.mock.calls.length > 0 };
  } finally { vi.unstubAllEnvs(); }
}

it("lists only the target member's passkey IDs, names and dates for a registered operator", async () => {
  const key = await signingCredential(db, "managed-member");
  await signingCredential(db, "passkey-operator");
  const date = new Date("2026-01-01T12:00:00Z");
  await db.update(passkey).set({ name: "Primary", createdAt: date }).where(eq(passkey.id, key.id));
  const result = await run("list-passkeys", operator, member);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.output[0])).toEqual([{ id: key.id, name: "Primary", addedAt: date.toISOString() }]);
  expect(await run("list-passkeys", member, operator)).toMatchObject({ status: 1, output: [], errors: ["operator_required"] });
});

it("removes the selected passkey after confirmation and can clear all ordinary passkeys", async () => {
  const key = await signingCredential(db, "managed-member");
  expect(await run("remove-passkey", operator, member, key.id, note)).toMatchObject({ status: 1, opened: false });
  expect(await run("remove-passkey", operator, member, "missing", note, "--confirm")).toMatchObject({ status: 1, errors: ["passkey_not_found"] });
  const removed = await run("remove-passkey", operator, member, key.id, note, "--confirm");
  expect(removed.status).toBe(0);
  expect(JSON.parse(removed.output[0])).toMatchObject({ action: "remove-passkey", operatorId: "passkey-operator", memberId: "managed-member", removedIds: [key.id], reason: note });
  expect(await db.$count(passkey, eq(passkey.id, key.id))).toBe(0);
  const spare = await signingCredential(db, "managed-member");
  const all = await run("remove-all-passkeys", operator, member, note, "--confirm");
  expect(all.status).toBe(0);
  expect(JSON.parse(all.output[0]).removedIds).toContain(spare.id);
  expect(await db.$count(passkey, eq(passkey.userId, "managed-member"))).toBe(0);
  expect(await run("remove-all-passkeys", operator, member, note, "--confirm")).toMatchObject({ status: 1, errors: ["passkey_not_found"] });
  expect((await db.select().from(jobs).where(eq(jobs.kind, SEND_PASSKEY_NOTICE_JOB))).map(row => row.payload)).toContainEqual(expect.objectContaining({ action: "removed", userId: "managed-member" }));
});

it("keeps a final passkey for passkey-only sign-in and offers the existing recovery command", async () => {
  const key = await signingCredential(db, "protected-member");
  const spare = await signingCredential(db, "protected-member");
  expect((await run("remove-passkey", operator, protectedMember, spare.id, note, "--confirm")).status).toBe(0);
  const recovery = { status: 1, errors: [expect.stringContaining("manual passkey recovery")] };
  expect(await run("remove-passkey", operator, protectedMember, key.id, note, "--confirm")).toMatchObject(recovery);
  expect(await run("remove-all-passkeys", operator, protectedMember, note, "--confirm")).toMatchObject(recovery);
  expect(await db.$count(passkey, eq(passkey.userId, "protected-member"))).toBe(1);
  expect((await run(operator, protectedMember, "Member lost the remaining key", "Verified on the recorded contact channel")).status).toBe(0);
  expect(await db.$count(passkeyRecoveryPermits, eq(passkeyRecoveryPermits.userId, "protected-member"))).toBe(1);
});

it("unlinks only the target member's Google connections and queues a notice", async () => {
  await db.insert(account).values([
    { id: "target-google", userId: "managed-member", providerId: "google", accountId: "google-target" },
    { id: "other-google", userId: "protected-member", providerId: "google", accountId: "google-other" },
    { id: "other-provider", userId: "managed-member", providerId: "fixture", accountId: "provider-target" },
  ]);
  expect(await run("unlink-google", operator, member, note)).toMatchObject({ status: 1, opened: false });
  const result = await run("unlink-google", operator, member, note, "--confirm");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.output[0])).toMatchObject({ action: "unlink-google", removedIds: ["target-google"] });
  expect(await run("unlink-google", operator, member, note, "--confirm")).toMatchObject({ status: 1, errors: ["google_not_connected"] });
  expect((await db.select({ id: account.id }).from(account)).map(row => row.id).sort()).toEqual(["other-google", "other-provider"]);
  expect((await db.select().from(jobs).where(eq(jobs.kind, SEND_PASSKEY_NOTICE_JOB))).map(row => row.payload)).toContainEqual(expect.objectContaining({ action: "google_disconnected", userId: "managed-member" }));
});
