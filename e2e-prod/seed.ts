import { seedArticleReading } from "./seed-article-reading";
// Seed production-build browser tests (e2e-prod/): create invitations for the email arguments and print one invitation URL per line to stdout.
// Run before starting the production build, against DATABASE_URL or PGLITE_DATA_DIR. For PostgreSQL, run pnpm db:migrate first.
import { closeDb, getDb } from "../app/lib/db/client.server";
import { createInvitation } from "../app/lib/invitations.server";
import { inviteUrl } from "../app/lib/site-url";
import { seedMembers } from "../e2e/seed-members";
import { PROD_MEMBERS } from "./member-fixtures";
import { seedEarlyActions } from "../e2e/seed-early-actions";
import { account, user } from "../app/lib/db/schema";
import { inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const db = await getDb();
await seedMembers(db, process.env.E2E_SEED_DIR!, process.env.BETTER_AUTH_URL!, PROD_MEMBERS);
await seedEarlyActions(db, process.env.E2E_SEED_DIR!);
await seedArticleReading(db, process.env.E2E_SEED_DIR!);
if (process.env.E2E_MOTION_FIXTURES === "1") await (await import("./seed-motion-figures")).seedMotionFigures(db, process.env.E2E_SEED_DIR!);
if (process.env.E2E_GOOGLE_LOGIN === "1") {
  const members = await db.select({ id: user.id, email: user.email }).from(user)
    .where(inArray(user.email, ["google_reauthentication@example.com", "google_disconnect@example.com"]));
  await db.insert(account).values(members.map(member => ({
    id: randomUUID(), userId: member.id, providerId: "google", accountId: member.email.split("@")[0],
  })));
}
for (const email of process.argv.slice(2)) {
  const { token } = await createInvitation(db, { email });
  console.log(inviteUrl(token));
}
await closeDb(db);
process.exit(0);
