// A stand-in for a third-party checkout SDK (shaped like PayPal's JS SDK
// callbacks). It owns the paysheet state and calls merchant callbacks; it
// knows nothing about remote devices. This is the thing running in the VM.

import type { Address, CallbackName, LineItem, PaySheetState, ShippingOption } from "./protocol";

export interface CallbackActions {
  reject(reason?: string): void;
}

export interface ShippingUpdate {
  shippingOptions?: Omit<ShippingOption, "selected">[];
  tax?: number;
}

export interface PaySheetOptions {
  merchant: string;
  currency: string;
  items: LineItem[];
  // How long the SDK waits for a merchant callback before failing it.
  callbackTimeoutMs?: number;
  // Resume a paysheet from a persisted snapshot instead of starting fresh.
  initialState?: PaySheetState;
  onShippingAddressChange?(
    data: { shippingAddress: Address },
    actions: CallbackActions,
  ): Promise<ShippingUpdate | void>;
  onShippingOptionsChange?(
    data: { selectedShippingOption: ShippingOption },
    actions: CallbackActions,
  ): Promise<ShippingUpdate | void>;
  onApprove?(data: { orderId: string }): Promise<void>;
  onCancel?(): void;
}

export type CallbackOutcome = { status: "resolved" } | { status: "rejected"; reason: string };

class Rejected extends Error {}

export class PaySheet {
  private state: PaySheetState;
  private listeners = new Set<(s: PaySheetState) => void>();

  constructor(private opts: PaySheetOptions) {
    this.state = opts.initialState ?? createInitialState(opts.merchant, opts.currency, opts.items);
    // A callback that was in flight when the previous owner died is lost.
    if (this.state.busy) this.state = { ...this.state, busy: null, error: "INTERRUPTED" };
  }

  getState() {
    return this.state;
  }

  subscribe(fn: (s: PaySheetState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // These are the "user interactions" with the paysheet. Locally they'd be
  // click handlers; in the relay they're driven by messages from the device.

  setShippingAddress(address: Address, requestId: string): Promise<CallbackOutcome> {
    return this.runCallback(
      "onShippingAddressChange",
      requestId,
      (actions) => this.opts.onShippingAddressChange?.({ shippingAddress: address }, actions),
      (update) => {
        this.patch({ shippingAddress: address });
        this.applyUpdate(update);
      },
    );
  }

  selectShippingOption(optionId: string, requestId: string): Promise<CallbackOutcome> {
    const option = this.state.shippingOptions.find((o) => o.id === optionId);
    if (!option) return Promise.resolve({ status: "rejected", reason: "UNKNOWN_SHIPPING_OPTION" });
    return this.runCallback(
      "onShippingOptionsChange",
      requestId,
      (actions) => this.opts.onShippingOptionsChange?.({ selectedShippingOption: option }, actions),
      (update) => {
        this.patch({
          shippingOptions: this.state.shippingOptions.map((o) => ({ ...o, selected: o.id === optionId })),
        });
        this.applyUpdate(update);
      },
    );
  }

  approve(requestId: string): Promise<CallbackOutcome> {
    if (!this.state.shippingAddress) return Promise.resolve({ status: "rejected", reason: "ADDRESS_REQUIRED" });
    if (!this.state.shippingOptions.some((o) => o.selected))
      return Promise.resolve({ status: "rejected", reason: "SHIPPING_OPTION_REQUIRED" });
    const orderId = `ORD-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    return this.runCallback(
      "onApprove",
      requestId,
      () => this.opts.onApprove?.({ orderId }),
      () => this.patch({ status: "approved", orderId }),
    );
  }

  cancel() {
    this.patch({ status: "cancelled", busy: null });
    this.opts.onCancel?.();
  }

  private async runCallback(
    callback: CallbackName,
    requestId: string,
    invoke: (actions: CallbackActions) => Promise<ShippingUpdate | void> | undefined,
    commit: (update: ShippingUpdate | void) => void,
  ): Promise<CallbackOutcome> {
    if (this.state.status !== "open") return { status: "rejected", reason: "PAYSHEET_CLOSED" };
    if (this.state.busy) return { status: "rejected", reason: "BUSY" };

    this.patch({ busy: { callback, requestId }, error: null });

    let rejectReason: string | null = null;
    const actions: CallbackActions = {
      reject: (reason = "REJECTED") => {
        rejectReason = reason;
      },
    };

    const timeoutMs = this.opts.callbackTimeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Rejected("CALLBACK_TIMEOUT")), timeoutMs);
    });

    try {
      // Merchant code calls actions.reject() and returns, like PayPal; state
      // only changes if it didn't reject and didn't time out.
      const update = await Promise.race([Promise.resolve(invoke(actions)), timeout]);
      if (rejectReason) throw new Rejected(rejectReason);
      commit(update);
      this.patch({ busy: null });
      return { status: "resolved" };
    } catch (err) {
      const reason = err instanceof Rejected ? err.message : "CALLBACK_ERROR";
      this.patch({ busy: null, error: reason });
      return { status: "rejected", reason };
    } finally {
      clearTimeout(timer);
    }
  }

  private applyUpdate(update: ShippingUpdate | void) {
    if (!update) return this.recompute();
    if (update.shippingOptions) {
      const prev = this.state.shippingOptions.find((o) => o.selected)?.id;
      const opts = update.shippingOptions;
      const keep = opts.some((o) => o.id === prev) ? prev : opts[0]?.id;
      this.state = { ...this.state, shippingOptions: opts.map((o) => ({ ...o, selected: o.id === keep })) };
    }
    if (update.tax !== undefined) this.state = { ...this.state, tax: update.tax };
    this.recompute();
  }

  private recompute() {
    const shipping = this.state.shippingOptions.find((o) => o.selected)?.amount ?? 0;
    this.patch({ total: round2(sumItems(this.state.items) + shipping + this.state.tax) });
  }

  private patch(p: Partial<PaySheetState>) {
    this.state = { ...this.state, ...p };
    this.listeners.forEach((fn) => fn(this.state));
  }
}

export function createInitialState(merchant: string, currency: string, items: LineItem[]): PaySheetState {
  return {
    status: "open",
    merchant,
    currency,
    items,
    shippingAddress: null,
    shippingOptions: [],
    tax: 0,
    total: sumItems(items),
    busy: null,
    error: null,
    orderId: null,
  };
}

export function sumItems(items: LineItem[]) {
  return round2(items.reduce((s, i) => s + i.unitAmount * i.quantity, 0));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
