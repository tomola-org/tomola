import { eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries } from "~/lib/db/schema";
import { setStance, type SetStanceInput } from "~/lib/stances.server";

export async function readQuestionSourceHash(db: Db, questionId: number): Promise<string | null> {
  const [row] = await db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, questionId));
  return row?.sourceHash ?? null;
}

export async function setCurrentStance(db: Db, userId: string, input: Omit<SetStanceInput, "questionSourceHash">, opts?: { now?: Date }) {
  const questionSourceHash = input.position === null ? null : await readQuestionSourceHash(db, input.questionId);
  return setStance(db, userId, { ...input, questionSourceHash }, opts);
}
