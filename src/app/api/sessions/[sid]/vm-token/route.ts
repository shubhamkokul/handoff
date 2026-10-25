import { NextResponse, type NextRequest } from "next/server";
import { adminAuth } from "@/lib/firebase-admin";
import { getIndexEntry, originOf, shareUrlFor } from "@/lib/server/sessions";

// Mint a VM-role token for an existing session: used both by a freshly
// launched VM tab and by one reconnecting to an earlier session.
export async function POST(req: NextRequest, { params }: { params: Promise<{ sid: string }> }) {
  const { sid } = await params;
  const idx = await getIndexEntry(sid);
  if (!idx) return NextResponse.json({ error: "unknown_session" }, { status: 404 });
  if (idx.expiresAt < Date.now()) return NextResponse.json({ error: "expired" }, { status: 410 });

  const vmToken = await adminAuth.createCustomToken(`vm:${sid}`, { sid, role: "vm" });
  return NextResponse.json({ sid, vmToken, label: idx.label, shareUrl: shareUrlFor(originOf(req), idx.code), expiresAt: idx.expiresAt });
}
