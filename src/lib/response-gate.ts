// Lets a human (or a test) decide when the merchant answers a callback,
// instead of simulating latency with timers. Open by default: callbacks
// answer immediately.

import type { CallbackName } from "./protocol";

export class ResponseGate {
  private held: { callback: CallbackName; release: () => void }[] = [];
  private listeners = new Set<() => void>();
  private holding = false;

  wait = (callback: CallbackName): Promise<void> => {
    if (!this.holding) return Promise.resolve();
    return new Promise<void>((release) => {
      this.held.push({ callback, release });
      this.emit();
    });
  };

  get isHolding() {
    return this.holding;
  }

  get pending(): CallbackName[] {
    return this.held.map((h) => h.callback);
  }

  setHolding(holding: boolean) {
    this.holding = holding;
    if (!holding) this.releaseAll();
    else this.emit();
  }

  releaseAll() {
    const held = this.held;
    this.held = [];
    held.forEach((h) => h.release());
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }
}
