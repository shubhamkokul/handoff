import { NextResponse, type NextRequest } from "next/server";
import { adminAuth, adminDb } from "@/lib/firebase-admin";

// The device exchanges the share code for a device-role token scoped to one
// session. Re-redeemable until expiry so a page reload can reconnect.
export async function POST(req: NextRequest) {
  const { code } = (await req.json().catch(() => ({}))) as { code?: string };
  if (!code || !/^[A-Za-z0-9_-]{8,64}$/.test(code)) {
    return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  }

  const snap = await adminDb.ref(`shareCodes/${code}`).get();
  const entry = snap.val() as { sid: string; expiresAt: number } | null;
  if (!entry || entry.expiresAt < Date.now()) {
    return NextResponse.json({ error: "expired_or_unknown" }, { status: 404 });
  }

  const metaRef = adminDb.ref(`sessions/${entry.sid}/meta/status`);
  await metaRef.transaction((s) => (s === "waiting" ? "active" : s));

  const deviceToken = await adminAuth.createCustomToken(`device:${entry.sid}`, { sid: entry.sid, role: "device" });
  return NextResponse.json({ sid: entry.sid, deviceToken, expiresAt: entry.expiresAt });
}
