// Delete expired sessions (or all, with --all) and their share codes / index
// rows. Run by hand instead of a scheduled Cloud Function, which would need
// the paid Blaze plan.
//
//   npm run cleanup:live            # expired only
//   npm run cleanup:live -- --all   # everything
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const useEmulators = process.env.NEXT_PUBLIC_USE_EMULATORS === "true";
const app = initializeApp({
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
  ...(useEmulators ? {} : { credential: cert(process.env.GOOGLE_APPLICATION_CREDENTIALS!) }),
});
const db = getDatabase(app);
const all = process.argv.includes("--all");

async function main() {
  const index = ((await db.ref("sessionIndex").get()).val() ?? {}) as Record<string, { code: string; expiresAt: number }>;
  const now = Date.now();
  const updates: Record<string, null> = {};
  for (const [sid, idx] of Object.entries(index)) {
    if (!all && idx.expiresAt > now) continue;
    updates[`sessions/${sid}`] = null;
    updates[`sessionIndex/${sid}`] = null;
    updates[`shareCodes/${idx.code}`] = null;
  }
  const n = Object.keys(updates).length / 3;
  if (n) await db.ref().update(updates);
  console.log(`deleted ${n} session(s) of ${Object.keys(index).length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
