"use client";

import { useState } from "react";
import type { Address, PaySheetState } from "@/lib/protocol";

const PRESETS: { label: string; address: Address }[] = [
  { label: "San Francisco, CA", address: { line1: "1 Market St", city: "San Francisco", state: "CA", postalCode: "94105", countryCode: "US" } },
  { label: "Austin, TX", address: { line1: "500 Congress Ave", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" } },
  { label: "Honolulu, HI", address: { line1: "2255 Kalakaua Ave", city: "Honolulu", state: "HI", postalCode: "96815", countryCode: "US" } },
  { label: "Toronto (rejected)", address: { line1: "100 Queen St W", city: "Toronto", state: "ON", postalCode: "M5H2N2", countryCode: "CA" } },
  { label: "Bad ZIP (rejected)", address: { line1: "1 Nowhere Rd", city: "Nowhere", state: "NV", postalCode: "00000", countryCode: "US" } },
];

const CALLBACK_LABEL: Record<string, string> = {
  onShippingAddressChange: "Checking address with merchant…",
  onShippingOptionsChange: "Updating shipping…",
  onApprove: "Placing order…",
};

export interface PaySheetHandlers {
  onSetAddress(a: Address): void;
  onSelectOption(id: string): void;
  onApprove(): void;
  onCancel(): void;
}

export function PaySheetView({
  state,
  handlers,
  disabled,
}: {
  state: PaySheetState;
  handlers: PaySheetHandlers;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState<Address>(state.shippingAddress ?? PRESETS[0].address);
  const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: state.currency }).format(n);
  const busy = !!state.busy;
  const locked = disabled || busy || state.status !== "open";
  const shipping = state.shippingOptions.find((o) => o.selected)?.amount ?? 0;

  if (state.status === "approved") {
    return (
      <div className="sheet done">
        <div className="done-mark">✓</div>
        <h2>Payment approved</h2>
        <p className="muted">Order {state.orderId} · {money(state.total)}</p>
      </div>
    );
  }
  if (state.status === "cancelled") {
    return (
      <div className="sheet done">
        <h2>Checkout cancelled</h2>
      </div>
    );
  }

  return (
    <div className="sheet" aria-busy={busy}>
      <header className="sheet-head">
        <span className="brand">PaySheet</span>
        <span className="muted">{state.merchant}</span>
      </header>

      <section>
        <h3>Items</h3>
        {state.items.map((i) => (
          <div className="row" key={i.name}>
            <span>{i.name} × {i.quantity}</span>
            <span>{money(i.unitAmount * i.quantity)}</span>
          </div>
        ))}
      </section>

      <section>
        <h3>Ship to</h3>
        <div className="chips">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" className="chip" disabled={locked} onClick={() => setDraft(p.address)}>
              {p.label}
            </button>
          ))}
        </div>
        <form
          className="addr"
          onSubmit={(e) => {
            e.preventDefault();
            handlers.onSetAddress(draft);
          }}
        >
          <input aria-label="Street" value={draft.line1} disabled={locked} onChange={(e) => setDraft({ ...draft, line1: e.target.value })} />
          <div className="addr-grid">
            <input aria-label="City" value={draft.city} disabled={locked} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
            <input aria-label="State" value={draft.state} disabled={locked} onChange={(e) => setDraft({ ...draft, state: e.target.value })} />
            <input aria-label="ZIP" value={draft.postalCode} disabled={locked} onChange={(e) => setDraft({ ...draft, postalCode: e.target.value })} />
            <input aria-label="Country" value={draft.countryCode} disabled={locked} onChange={(e) => setDraft({ ...draft, countryCode: e.target.value })} />
          </div>
          <button type="submit" className="secondary" disabled={locked}>Use this address</button>
        </form>
        {state.shippingAddress && (
          <p className="muted small">
            Confirmed: {state.shippingAddress.line1}, {state.shippingAddress.city}, {state.shippingAddress.state} {state.shippingAddress.postalCode}
          </p>
        )}
      </section>

      {state.shippingOptions.length > 0 && (
        <section>
          <h3>Shipping</h3>
          {state.shippingOptions.map((o) => (
            <label className="option" key={o.id}>
              <input
                type="radio"
                name="ship"
                checked={o.selected}
                disabled={locked}
                onChange={() => handlers.onSelectOption(o.id)}
              />
              <span>{o.label}</span>
              <span className="grow" />
              <span>{o.amount === 0 ? "Free" : money(o.amount)}</span>
            </label>
          ))}
        </section>
      )}

      <section className="totals">
        <div className="row muted"><span>Shipping</span><span>{money(shipping)}</span></div>
        <div className="row muted"><span>Tax</span><span>{money(state.tax)}</span></div>
        <div className="row total"><span>Total</span><span>{money(state.total)}</span></div>
      </section>

      {state.error && <div className="error" role="alert">Merchant rejected: {state.error}</div>}

      <div className="actions">
        <button type="button" className="ghost" disabled={locked} onClick={handlers.onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={locked} onClick={handlers.onApprove}>
          Pay {money(state.total)}
        </button>
      </div>

      {busy && (
        <div className="overlay">
          <div className="spinner" />
          <span>{CALLBACK_LABEL[state.busy!.callback]}</span>
          <code className="small">{state.busy!.callback}</code>
        </div>
      )}
    </div>
  );
}

export function EventLog({ entries }: { entries: { t: number; dir: string; text: string }[] }) {
  return (
    <div className="log">
      {entries.length === 0 && <div className="muted small">No messages yet.</div>}
      {entries.map((e, i) => (
        <div key={i} className={`log-line ${e.dir}`}>
          <span className="log-time">{new Date(e.t).toLocaleTimeString([], { hour12: false })}</span>
          <span className="log-dir">{e.dir === "in" ? "←" : e.dir === "out" ? "→" : "·"}</span>
          <span>{e.text}</span>
        </div>
      ))}
    </div>
  );
}

export function useLog() {
  const [entries, setEntries] = useState<{ t: number; dir: string; text: string }[]>([]);
  const log = (dir: "in" | "out" | "info", text: string) =>
    setEntries((prev) => [{ t: Date.now(), dir, text }, ...prev].slice(0, 200));
  return [entries, log] as const;
}
