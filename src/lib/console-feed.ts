"use client";

// Live session list for the operator console: one query on the index, plus a
// listener per session. No polling; every change pushes a new list.

import { limitToLast, onValue, orderByChild, query, ref, type Database } from "firebase/database";
import type { PaySheetState, SessionMeta, SessionSummary } from "./protocol";

interface IndexEntry {
  code: string;
  label: string;
  createdAt: number;
  expiresAt: number;
}

interface Live {
  meta?: SessionMeta;
  presence?: { vm?: boolean; device?: boolean };
  paysheet?: Partial<PaySheetState>;
  unsub: () => void;
}

export function watchSessions(db: Database, origin: string, onChange: (s: SessionSummary[]) => void, limit = 50) {
  let index: [string, IndexEntry][] = [];
  const live = new Map<string, Live>();

  const emit = () => {
    const now = Date.now();
    onChange(
      index.map(([sid, idx]) => {
        const l = live.get(sid);
        return {
          sid,
          label: idx.label,
          status: idx.expiresAt < now ? "expired" : (l?.meta?.status ?? "waiting"),
          createdAt: idx.createdAt,
          expiresAt: idx.expiresAt,
          shareUrl: `${origin}/pay/${idx.code}`,
          vmOnline: !!l?.presence?.vm,
          deviceOnline: !!l?.presence?.device,
          total: l?.paysheet?.total ?? null,
          currency: l?.paysheet?.currency ?? "USD",
          busy: l?.paysheet?.busy?.callback ?? null,
        };
      }),
    );
  };

  const watch = (sid: string): Live => {
    const entry: Live = { unsub: () => {} };
    const base = `sessions/${sid}`;
    const unsubs = [
      onValue(ref(db, `${base}/meta`), (s) => ((entry.meta = s.val() ?? undefined), emit())),
      onValue(ref(db, `${base}/presence`), (s) => ((entry.presence = s.val() ?? undefined), emit())),
      onValue(ref(db, `${base}/state/paysheet`), (s) => ((entry.paysheet = s.val() ?? undefined), emit())),
    ];
    entry.unsub = () => unsubs.forEach((u) => u());
    return entry;
  };

  const unsubIndex = onValue(query(ref(db, "sessionIndex"), orderByChild("createdAt"), limitToLast(limit)), (snap) => {
    const next: [string, IndexEntry][] = [];
    snap.forEach((c) => {
      next.push([c.key!, c.val()]);
    });
    index = next.reverse(); // newest first
    const keep = new Set(index.map(([sid]) => sid));
    for (const [sid, l] of live) if (!keep.has(sid)) (l.unsub(), live.delete(sid));
    for (const sid of keep) if (!live.has(sid)) live.set(sid, watch(sid));
    emit();
  });

  return () => {
    unsubIndex();
    live.forEach((l) => l.unsub());
    live.clear();
  };
}
