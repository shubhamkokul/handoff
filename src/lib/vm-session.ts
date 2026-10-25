// Boots (or resumes) the SDK for one session inside the VM: rehydrate from the
// persisted snapshot, take the VM lease, wire the SDK to the relay.

import { get, ref, type Database } from "firebase/database";
import { createChannel } from "./channel";
import { PaySheet } from "./mock-paysheet-sdk";
import { merchantCallbacks } from "./merchant";
import { bridgeVm, type LogFn, type VmEvent } from "./vm-bridge";
import { newId, normalizePaySheet, type CallbackName, type PaySheetState, type StateSnapshot, type ToDeviceMessage, type ToVmMessage } from "./protocol";

export interface VmSessionOptions {
  db: Database;
  sid: string;
  log: LogFn;
  // Optional hold on merchant responses (see ResponseGate).
  beforeMerchantResponds?: (callback: CallbackName) => Promise<void>;
  callbackTimeoutMs?: number;
  onState?: (s: PaySheetState) => void;
  onDevicePresence?: (online: boolean) => void;
  // Step-by-step activity: request received, callback triggered, result sent.
  onEvent?: (e: VmEvent) => void;
  // Another VM tab claimed the session; this one has already stopped.
  onTakenOver?: () => void;
}

export interface VmSession {
  sheet: PaySheet;
  resumed: boolean;
  stop(): void;
}

export async function startVmSession(o: VmSessionOptions): Promise<VmSession> {
  const channel = createChannel<ToDeviceMessage, ToVmMessage>(o.db, o.sid, "vm");

  const snap = (await get(ref(o.db, `sessions/${o.sid}/state`))).val() as StateSnapshot | null;
  if (!snap?.paysheet) throw new Error("Session has no state.");
  const persisted = normalizePaySheet(snap.paysheet);
  const resumed = snap.seq > 0;
  o.log("info", resumed ? `resumed session at seq ${snap.seq}` : "new session");

  const teardown: Array<() => void> = [];
  let stopped = false;
  const stopListeners = () => {
    if (stopped) return;
    stopped = true;
    teardown.forEach((t) => t());
  };

  await channel.acquireVmLease(newId("tab"), () => {
    stopListeners();
    o.log("info", "session taken over by another VM tab");
    o.onTakenOver?.();
  });

  const sheet = new PaySheet({
    merchant: persisted.merchant,
    currency: persisted.currency,
    items: persisted.items,
    initialState: persisted,
    callbackTimeoutMs: o.callbackTimeoutMs ?? 10_000,
    ...merchantCallbacks(persisted.items, o.beforeMerchantResponds),
    onCancel: () => o.log("info", "SDK onCancel fired"),
  });

  if (o.onState) {
    o.onState(sheet.getState());
    teardown.push(sheet.subscribe(o.onState));
  }
  teardown.push(
    bridgeVm(sheet, channel, o.log, {
      seq: snap.seq,
      interrupted: persisted.busy && { requestId: persisted.busy.requestId, callback: persisted.busy.callback },
    }, o.onEvent),
  );
  if (o.onDevicePresence) teardown.push(channel.onPeerPresence(o.onDevicePresence));

  return {
    sheet,
    resumed,
    stop() {
      stopListeners();
      channel.close();
    },
  };
}
