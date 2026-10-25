"use client";

import {
  ref,
  push,
  remove,
  set,
  onChildAdded,
  onValue,
  onDisconnect,
  type Database,
} from "firebase/database";
import type { Role, SessionMeta, StateSnapshot } from "./protocol";

// The only file that knows the transport is Firebase RTDB. Swap this for a
// WebSocket implementation later and nothing above it changes.
export interface Channel<Out, In> {
  send(msg: Out): Promise<void>;
  onMessage(cb: (msg: In) => void): () => void;
  onPeerPresence(cb: (online: boolean) => void): () => void;
  onState(cb: (snap: StateSnapshot | null) => void): () => void;
  // VM only (enforced by rules): publish the authoritative paysheet snapshot.
  publishState(snap: StateSnapshot): Promise<void>;
  setStatus(status: SessionMeta["status"]): Promise<void>;
  // VM only: claim exclusive ownership of the session's SDK. Newest tab wins;
  // onLost fires in the previous owner so it can stand down.
  acquireVmLease(tabId: string, onLost: () => void): Promise<void>;
  close(): void;
}

export function createChannel<Out, In>(db: Database, sid: string, role: Role): Channel<Out, In> {
  const base = `sessions/${sid}`;
  const outbox = role === "vm" ? "toDevice" : "toVm";
  const inbox = role === "vm" ? "toVm" : "toDevice";
  const peer: Role = role === "vm" ? "device" : "vm";
  const unsubs: Array<() => void> = [];
  let leaseLost = false;

  // Presence: re-assert on every (re)connect, server clears it on disconnect.
  const myPresence = ref(db, `${base}/presence/${role}`);
  const unsubPresence = onValue(ref(db, ".info/connected"), (snap) => {
    if (snap.val() !== true) return;
    onDisconnect(myPresence)
      .remove()
      .then(() => set(myPresence, true));
  });
  unsubs.push(unsubPresence);

  return {
    async send(msg) {
      await push(ref(db, `${base}/${outbox}`), msg);
    },

    onMessage(cb) {
      // Children arrive in push-key (chronological) order. Each message is
      // deleted once consumed, so a reconnect never replays old messages.
      const unsub = onChildAdded(ref(db, `${base}/${inbox}`), (snap) => {
        const msg = snap.val() as In;
        remove(snap.ref).catch(() => {});
        cb(msg);
      });
      unsubs.push(unsub);
      return unsub;
    },

    onPeerPresence(cb) {
      const unsub = onValue(ref(db, `${base}/presence/${peer}`), (snap) => cb(snap.val() === true));
      unsubs.push(unsub);
      return unsub;
    },

    onState(cb) {
      const unsub = onValue(ref(db, `${base}/state`), (snap) => cb(snap.val() as StateSnapshot | null));
      unsubs.push(unsub);
      return unsub;
    },

    async publishState(snap) {
      await set(ref(db, `${base}/state`), snap);
    },

    async setStatus(status) {
      await set(ref(db, `${base}/meta/status`), status);
    },

    async acquireVmLease(tabId, onLost) {
      const lease = ref(db, `${base}/vmLease`);
      await onDisconnect(lease).remove();
      await set(lease, tabId);
      const unsub = onValue(lease, (snap) => {
        if (snap.val() === tabId) return;
        // Someone else owns it now. Stand down without disturbing the new
        // owner: cancel our disconnect hooks, which would clear its lease and presence.
        if (snap.exists()) {
          leaseLost = true;
          unsub();
          unsubPresence();
          onDisconnect(lease).cancel().catch(() => {});
          onDisconnect(myPresence).cancel().catch(() => {});
          onLost();
        }
      });
      unsubs.push(unsub);
    },

    close() {
      unsubs.forEach((u) => u());
      if (!leaseLost) remove(myPresence).catch(() => {});
    },
  };
}
