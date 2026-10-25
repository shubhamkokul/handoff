import { NextResponse, type NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { adminDb } from "@/lib/firebase-admin";
import { createInitialState } from "@/lib/mock-paysheet-sdk";
import { SCENARIOS } from "@/lib/merchant";
import { originOf, shareUrlFor, TTL_MS, type IndexEntry } from "@/lib/server/sessions";
import type { SessionMeta, StateSnapshot } from "@/lib/protocol";

// Launch a new VM paysheet session. In production this is called by whatever
// boots the VM and must be service-authenticated.
export async function POST(req: NextRequest) {
  const sid = randomUUID();
  // Opaque, unguessable, short-lived. The Firebase token never goes in a URL.
  const code = randomBytes(12).toString("base64url");
  const now = Date.now();

  const n = (await adminDb.ref("counters/session").transaction((c: number | null) => (c ?? 1000) + 1)).snapshot.val();
  const scenario = SCENARIOS[n % SCENARIOS.length];
  const label = `#${n} · ${scenario.merchant}`;

  const meta: SessionMeta = { status: "waiting", label, createdAt: now, expiresAt: now + TTL_MS };
  const index: IndexEntry = { code, label, createdAt: now, expiresAt: meta.expiresAt };
  // The SDK's initial state is persisted up front, so opening a VM tab for a
  // new session and resuming an old one are the same code path.
  const state: StateSnapshot = { seq: 0, paysheet: createInitialState(scenario.merchant, "USD", scenario.items) };

  await adminDb.ref().update({
    [`sessions/${sid}/meta`]: meta,
    [`sessions/${sid}/state`]: state,
    [`shareCodes/${code}`]: { sid, expiresAt: meta.expiresAt },
    [`sessionIndex/${sid}`]: index,
  });

  return NextResponse.json({ sid, label, shareUrl: shareUrlFor(originOf(req), code), expiresAt: meta.expiresAt });
}
