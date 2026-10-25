"use client";

// Runs next to the SDK in the VM. Turns device messages into SDK interactions
// (which fire merchant callbacks) and reports callback outcomes back.

import type { Channel } from "./channel";
import type { CallbackOutcome, PaySheet } from "./mock-paysheet-sdk";
import type { CallbackName, PaySheetState, ToDeviceMessage, ToVmMessage } from "./protocol";

export type LogFn = (dir: "in" | "out" | "info", text: string) => void;

// What the VM did with each device request, step by step, for the VM's
// activity view. `id` is the device's request id.
export type VmEvent =
  | { kind: "received"; id: string; ts: number; action: ToVmMessage["action"]; payload: unknown }
  | { kind: "callback_triggered"; id: string; ts: number; callback: CallbackName }
  | {
      kind: "callback_finished";
      id: string;
      ts: number;
      callback: CallbackName | null;
      status: "resolved" | "rejected";
      reason: string | null;
      state: PaySheetState; // SDK state right after, for a human-readable summary
    }
  | { kind: "result_sent"; id: string; ts: number };

export function bridgeVm(
  sheet: PaySheet,
  channel: Channel<ToDeviceMessage, ToVmMessage>,
  log: LogFn,
  // When resuming: continue the snapshot sequence, and fail the callback that
  // the previous owner never finished so the device isn't left waiting.
  resume?: { seq: number; interrupted: { requestId: string; callback: CallbackName } | null },
  onEvent: (e: VmEvent) => void = () => {},
): () => void {
  let seq = resume?.seq ?? 0;
  let active = true;
  const seen = new Set<string>();
  if (resume?.interrupted) {
    const { requestId, callback } = resume.interrupted;
    seen.add(requestId);
    void reply(requestId, callback, { status: "rejected", reason: "INTERRUPTED" });
  }

  // Every SDK state change is published as a full snapshot. The device
  // renders snapshots, never diffs.
  const publish = () => channel.publishState({ seq: ++seq, paysheet: sheet.getState() });
  const unsubState = sheet.subscribe(() => void publish());
  void publish();

  const unsubMsg = channel.onMessage(async (msg) => {
    if (msg.type !== "action" || seen.has(msg.id)) return; // idempotent on retries
    seen.add(msg.id);
    log("in", `${msg.action} ${msg.payload ? JSON.stringify(msg.payload) : ""} [${msg.id}]`);
    onEvent({ kind: "received", id: msg.id, ts: Date.now(), action: msg.action, payload: msg.payload ?? null });

    if (msg.action === "cancel") {
      sheet.cancel();
      await reply(msg.id, null, { status: "resolved" });
      await channel.setStatus("cancelled");
      return;
    }

    const callback = CALLBACK_FOR[msg.action];
    onEvent({ kind: "callback_triggered", id: msg.id, ts: Date.now(), callback });
    await channel.send({ type: "callback_pending", ref: msg.id, callback, ts: Date.now() });
    log("out", `callback_pending ${callback} [${msg.id}]`);

    let outcome: CallbackOutcome;
    switch (msg.action) {
      case "set_shipping_address":
        outcome = await sheet.setShippingAddress(msg.payload, msg.id);
        break;
      case "select_shipping_option":
        outcome = await sheet.selectShippingOption(msg.payload.optionId, msg.id);
        break;
      case "approve":
        outcome = await sheet.approve(msg.id);
        break;
    }

    // If another VM tab took over while the callback ran, it already told
    // the device this request was interrupted; stay quiet.
    if (!active) return;
    await reply(msg.id, callback, outcome);
    if (msg.action === "approve" && outcome.status === "resolved") await channel.setStatus("complete");
  });

  async function reply(ref: string, callback: CallbackName | null, outcome: CallbackOutcome) {
    const reason = outcome.status === "rejected" ? outcome.reason : null;
    onEvent({ kind: "callback_finished", id: ref, ts: Date.now(), callback, status: outcome.status, reason, state: sheet.getState() });
    // Resolves once RTDB has the message, i.e. it's on its way to the device.
    await channel.send({ type: "callback_result", ref, callback, status: outcome.status, reason, ts: Date.now() });
    onEvent({ kind: "result_sent", id: ref, ts: Date.now() });
    log("out", `callback_result ${outcome.status}${reason ? ` (${reason})` : ""} [${ref}]`);
  }

  return () => {
    active = false;
    unsubState();
    unsubMsg();
  };
}

const CALLBACK_FOR: Record<Exclude<ToVmMessage["action"], "cancel">, CallbackName> = {
  set_shipping_address: "onShippingAddressChange",
  select_shipping_option: "onShippingOptionsChange",
  approve: "onApprove",
};
