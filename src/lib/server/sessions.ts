import "server-only";
import { adminDb } from "@/lib/firebase-admin";

export const TTL_MS = Number(process.env.SESSION_TTL_SECONDS ?? 7200) * 1000;

// Admin-only index so the operator console can list sessions without clients
// ever being able to enumerate them.
export interface IndexEntry {
  code: string;
  label: string;
  createdAt: number;
  expiresAt: number;
}

export async function getIndexEntry(sid: string): Promise<IndexEntry | null> {
  return (await adminDb.ref(`sessionIndex/${sid}`).get()).val();
}

export function shareUrlFor(origin: string, code: string) {
  return `${origin}/pay/${code}`;
}

export function originOf(req: Request & { nextUrl?: URL }) {
  return req.headers.get("origin") ?? req.nextUrl?.origin ?? new URL(req.url).origin;
}
