"use client";

// Device side: turns UI interactions into request/response calls over the
// channel, correlated by id, with a timeout in case the VM goes away.

import type { Channel } from "./channel";
import { newId, type DeviceAction, type ToDeviceMessage, type ToVmMessage } from "./protocol";
import type { LogFn } from "./vm-bridge";

export type Outcome = { status: "resolved" } | { status: "rejected"; reason: string };

// Longer than the SDK's own callback timeout, so the SDK's verdict wins.
const REQUEST_TIMEOUT_MS = 15_000;

export class DeviceClient {
  private pending = new Map<string, { resolve: (o: Outcome) => void; timer: ReturnType<typeof setTimeout> }>();
  private unsub: () => void;

  constructor(
    private channel: Channel<ToVmMessage, ToDeviceMessage>,
    private log: LogFn,
  ) {
    this.unsub = channel.onMessage((msg) => this.handle(msg));
  }

  request(action: DeviceAction): Promise<Outcome> {
    const id = newId("dev");
    return new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log("info", `timeout waiting for VM [${id}]`);
        resolve({ status: "rejected", reason: "RELAY_TIMEOUT" });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });

      this.log("out", `${action.action} ${action.payload ? JSON.stringify(action.payload) : ""} [${id}]`);
      this.channel.send({ type: "action", id, ts: Date.now(), ...action } as ToVmMessage).catch((err) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ status: "rejected", reason: `SEND_FAILED: ${err?.message ?? err}` });
      });
    });
  }

  close() {
    this.unsub();
    this.pending.forEach((p) => clearTimeout(p.timer));
    this.pending.clear();
  }

  private handle(msg: ToDeviceMessage) {
    if (msg.type === "callback_pending") {
      this.log("in", `callback_pending ${msg.callback} [${msg.ref}]`);
      return;
    }
    this.log("in", `callback_result ${msg.status}${msg.reason ? ` (${msg.reason})` : ""} [${msg.ref}]`);
    const p = this.pending.get(msg.ref);
    if (!p) return; // late reply after timeout, or from a previous page load
    clearTimeout(p.timer);
    this.pending.delete(msg.ref);
    p.resolve(msg.status === "resolved" ? { status: "resolved" } : { status: "rejected", reason: msg.reason ?? "REJECTED" });
  }
}
