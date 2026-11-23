import { cliOutput, isMain, runCli, type CliOutput } from "./cli";
import { safeErrorText } from "../app/lib/error-text.server.ts";
import { eq } from "drizzle-orm";
import { closeDb, getOperatorDb, type Db } from "../app/lib/db/client.server";
import { user } from "../app/lib/db/schema";
import { parseEmail } from "../app/lib/email";
import { manageMemberLoginMethods, recoverPasskeys, type LoginMethodOperation } from "../app/lib/auth/passkeys.server";
import { SigningError } from "../app/lib/signing.server";

const usage = `usage: pnpm exec tsx scripts/recover-passkeys.ts <operator-email> <member-email> '<reason>' '<identity verification method and evidence>'
       pnpm exec tsx scripts/recover-passkeys.ts list-passkeys <operator-email> <member-email>
       pnpm exec tsx scripts/recover-passkeys.ts remove-passkey <operator-email> <member-email> <passkey-id> '<reason>' --confirm
       pnpm exec tsx scripts/recover-passkeys.ts remove-all-passkeys <operator-email> <member-email> '<reason>' --confirm
       pnpm exec tsx scripts/recover-passkeys.ts unlink-google <operator-email> <member-email> '<reason>' --confirm`;

function operationKind(value: string): value is LoginMethodOperation["kind"] {
  return value === "list-passkeys" || value === "remove-passkey" || value === "remove-all-passkeys" || value === "unlink-google";
}

export async function runPasskeyOperatorCli(argv: string[], openDb: () => Promise<Db> = getOperatorDb, output: CliOutput = cliOutput) {
  const kind = operationKind(argv[0]) ? argv[0] : undefined;
  const [operatorInput, memberInput, ...details] = kind ? argv.slice(1) : argv;
  const operation: LoginMethodOperation | undefined = kind === "remove-passkey" ? { kind, id: details.shift() ?? "" } : kind ? { kind } : undefined;
  const operatorEmail = parseEmail(operatorInput ?? "");
  const memberEmail = parseEmail(memberInput ?? "");
  const list = operation?.kind === "list-passkeys";
  const [note = "", confirmation] = details;
  if (!operatorEmail || !memberEmail || (operation?.kind === "remove-passkey" && !operation.id)
    || (list ? details.length !== 0 : details.length !== 2 || note.trim().length < 10 || note.length > 4000
      || (operation ? confirmation !== "--confirm" : !confirmation?.trim() || confirmation.length > 4000))) {
    output.error(usage);
    return 1;
  }

  const db = await openDb();
  try {
    const [operator] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.email, operatorEmail));
    const [member] = await db.select({ id: user.id }).from(user).where(eq(user.email, memberEmail));
    if (!operator || !member) throw new Error("Operator or member account not found");
    if (!operation) {
      const result = await recoverPasskeys(db, operator, member.id, note, confirmation);
      output.log(`Recovery permitted until ${result.expiresAt.toISOString()}. All sessions and old credentials were revoked; the member will receive a one-time passkey registration link by email.`);
      return 0;
    }

    const result = await manageMemberLoginMethods(db, operator, member.id, operation);
    if ("keys" in result) output.log(JSON.stringify(result.keys, null, 2));
    else output.log(JSON.stringify({ action: operation.kind, memberId: member.id, operatorId: operator.id, reason: note.trim(), ...result }));
    return 0;
  } catch (error) {
    output.error(error instanceof SigningError && error.code === "last_passkey"
      ? "Keep at least one passkey for passkey-only sign-in. Use the manual passkey recovery command to replace the remaining keys."
      : safeErrorText(error));
    return 1;
  } finally { await closeDb(db); }
}

if (isMain(import.meta.url)) process.exitCode = await runCli(() => runPasskeyOperatorCli(process.argv.slice(2)));
