"use client";

import { useEffect, useState } from "react";
import type { Address, PaySheetState } from "@/lib/protocol";
import { formatMoney } from "./format";

// The device paysheet: laid out like a familiar wallet checkout (cart pill,
// Ship to, Shipping method, one big Pay button). It renders the VM's
// snapshot; every interaction is a request to the VM.

const PRESETS: { label: string; name: string; address: Address }[] = [
  { label: "San Francisco", name: "Alex Rivera", address: { line1: "1 Market St", city: "San Francisco", state: "CA", postalCode: "94105", countryCode: "US" } },
  { label: "Austin", name: "Alex Rivera", address: { line1: "500 Congress Ave", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" } },
  { label: "Honolulu", name: "Alex Rivera", address: { line1: "2255 Kalakaua Ave", city: "Honolulu", state: "HI", postalCode: "96815", countryCode: "US" } },
  { label: "Toronto (rejected)", name: "Alex Rivera", address: { line1: "100 Queen St W", city: "Toronto", state: "ON", postalCode: "M5H2N2", countryCode: "CA" } },
  { label: "Bad ZIP (rejected)", name: "Alex Rivera", address: { line1: "1 Nowhere Rd", city: "Nowhere", state: "NV", postalCode: "00000", countryCode: "US" } },
];

const BUSY_LABEL: Record<string, string> = {
  onShippingAddressChange: "Checking your address with the merchant…",
  onShippingOptionsChange: "Updating shipping…",
  onApprove: "Completing your purchase…",
};

// Merchant / SDK reason codes, in words a shopper would see.
function errorFor(reason: string, merchant: string): { where: "address" | "shipping" | "top"; text: string } {
  switch (reason) {
    case "COUNTRY_ERROR":
      return { where: "address", text: `${merchant} doesn't ship to this country. Choose a different address.` };
    case "ZIP_ERROR":
      return { where: "address", text: "That ZIP code doesn't look right. Check the address and try again." };
    case "METHOD_UNAVAILABLE":
      return { where: "shipping", text: "That shipping method isn't available right now. Choose another." };
    case "CALLBACK_TIMEOUT":
      return { where: "top", text: `${merchant} is taking too long to respond. Try again.` };
    case "INTERRUPTED":
      return { where: "top", text: "Checkout was interrupted. Try that again." };
    default:
      return { where: "top", text: `Something went wrong (${reason}). Try again.` };
  }
}

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
  notice,
}: {
  state: PaySheetState;
  handlers: PaySheetHandlers;
  disabled?: boolean;
  notice?: string | null;
}) {
  const money = (n: number) => formatMoney(n, state.currency);
  const [draft, setDraft] = useState<Address>(state.shippingAddress ?? PRESETS[0].address);
  const [editing, setEditing] = useState(!state.shippingAddress);
  const [cartOpen, setCartOpen] = useState(false);
  const busy = !!state.busy;
  const locked = disabled || busy || state.status !== "open";
  const subtotal = state.items.reduce((s, i) => s + i.unitAmount * i.quantity, 0);
  const shipping = state.shippingOptions.find((o) => o.selected);
  const err = state.error ? errorFor(state.error, state.merchant) : null;
  const a = state.shippingAddress;

  // Close the address editor once the merchant accepts a new address.
  const addrKey = a ? `${a.line1}|${a.postalCode}|${a.countryCode}` : "";
  useEffect(() => {
    if (addrKey) setEditing(false);
  }, [addrKey]);

  if (state.status === "approved") {
    return (
      <div className="ps-card ps-done">
        <Header merchant={state.merchant} total={money(state.total)} />
        <div className="ps-done-body">
          <div className="ps-check" aria-hidden>✓</div>
          <h1>You paid {money(state.total)}</h1>
          <p>to {state.merchant}</p>
          <p className="ps-muted">Order {state.orderId}. A receipt is on its way to your email.</p>
        </div>
        <Footer />
      </div>
    );
  }

  if (state.status === "cancelled") {
    return (
      <div className="ps-card ps-done">
        <Header merchant={state.merchant} total={money(state.total)} />
        <div className="ps-done-body">
          <h1>Checkout cancelled</h1>
          <p className="ps-muted">You haven&apos;t been charged. You can close this page.</p>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="ps-card" aria-busy={busy}>
      <Header merchant={state.merchant} total={money(state.total)} onCart={() => setCartOpen((v) => !v)} cartOpen={cartOpen} />

      {cartOpen && (
        <div className="ps-cart">
          {state.items.map((i) => (
            <div className="ps-row" key={i.name}>
              <span>{i.name}{i.quantity > 1 && <span className="ps-muted"> × {i.quantity}</span>}</span>
              <span>{money(i.unitAmount * i.quantity)}</span>
            </div>
          ))}
          <div className="ps-row ps-muted"><span>Subtotal</span><span>{money(subtotal)}</span></div>
          <div className="ps-row ps-muted"><span>Shipping</span><span>{shipping ? money(shipping.amount) : "—"}</span></div>
          <div className="ps-row ps-muted"><span>Tax</span><span>{money(state.tax)}</span></div>
          <div className="ps-row ps-strong"><span>Total</span><span>{money(state.total)}</span></div>
        </div>
      )}

      <div className="ps-body">
        <p className="ps-hello">Hi, Alex!</p>
        {notice && <div className="ps-alert">{notice}</div>}
        {err?.where === "top" && <div className="ps-alert">{err.text}</div>}

        <section className="ps-section">
          <div className="ps-section-head">
            <h2>Ship to</h2>
            {a && !editing && (
              <button className="ps-link" disabled={locked} onClick={() => setEditing(true)}>Change</button>
            )}
          </div>

          {a && !editing ? (
            <div className="ps-address">
              <strong>Alex Rivera</strong>
              <span>{a.line1}</span>
              <span>{a.city}, {a.state} {a.postalCode}</span>
              <span>{a.countryCode === "US" ? "United States" : a.countryCode}</span>
            </div>
          ) : (
            <form
              className="ps-form"
              onSubmit={(e) => {
                e.preventDefault();
                handlers.onSetAddress(draft);
              }}
            >
              <div className="ps-chips">
                {PRESETS.map((p) => (
                  <button key={p.label} type="button" className="ps-chip" disabled={locked} onClick={() => setDraft(p.address)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <Field label="Street address" value={draft.line1} disabled={locked} onChange={(v) => setDraft({ ...draft, line1: v })} />
              <div className="ps-grid">
                <Field label="City" value={draft.city} disabled={locked} onChange={(v) => setDraft({ ...draft, city: v })} />
                <Field label="State" value={draft.state} disabled={locked} onChange={(v) => setDraft({ ...draft, state: v })} />
                <Field label="ZIP code" value={draft.postalCode} disabled={locked} onChange={(v) => setDraft({ ...draft, postalCode: v })} />
                <Field label="Country" value={draft.countryCode} disabled={locked} onChange={(v) => setDraft({ ...draft, countryCode: v })} />
              </div>
              {err?.where === "address" && <div className="ps-alert">{err.text}</div>}
              <div className="ps-form-actions">
                {a && (
                  <button type="button" className="ps-link" disabled={locked} onClick={() => setEditing(false)}>Keep current address</button>
                )}
                <button type="submit" className="ps-btn-secondary" disabled={locked}>Ship to this address</button>
              </div>
            </form>
          )}
        </section>

        <section className="ps-section">
          <div className="ps-section-head">
            <h2>Shipping method</h2>
          </div>
          {state.shippingOptions.length === 0 ? (
            <p className="ps-muted ps-small">Add a shipping address to see shipping options.</p>
          ) : (
            <div className="ps-options" role="radiogroup">
              {state.shippingOptions.map((o) => (
                <label key={o.id} className={`ps-option ${o.selected ? "selected" : ""}`}>
                  <input
                    type="radio"
                    name="ship"
                    checked={o.selected}
                    disabled={locked}
                    onChange={() => handlers.onSelectOption(o.id)}
                  />
                  <span className="ps-option-label">{o.label}</span>
                  <span className="ps-option-price">{o.amount === 0 ? "Free" : money(o.amount)}</span>
                </label>
              ))}
            </div>
          )}
          {err?.where === "shipping" && <div className="ps-alert">{err.text}</div>}
        </section>

        <section className="ps-section">
          <div className="ps-section-head">
            <h2>Pay with</h2>
          </div>
          <div className="ps-funding">
            <span className="ps-funding-icon" aria-hidden>▤</span>
            <span>
              <strong>Visa Debit</strong>
              <span className="ps-muted"> •••• 4242</span>
            </span>
            <span className="ps-muted ps-small ps-funding-note">Demo card</span>
          </div>
        </section>

        <div className="ps-pay">
          <button className="ps-btn-primary" disabled={locked || !a || !shipping} onClick={handlers.onApprove}>
            Pay {money(state.total)}
          </button>
          <button className="ps-link ps-cancel" disabled={locked} onClick={handlers.onCancel}>
            Cancel and return to {state.merchant}
          </button>
        </div>
      </div>

      <Footer />

      {busy && (
        <div className="ps-overlay" role="status">
          <span className="ps-spinner" />
          <span>{BUSY_LABEL[state.busy!.callback]}</span>
        </div>
      )}
    </div>
  );
}

function Header({ merchant, total, onCart, cartOpen }: { merchant: string; total: string; onCart?: () => void; cartOpen?: boolean }) {
  return (
    <header className="ps-header">
      <span className="ps-logo">
        <span className="ps-logo-mark">P</span>
        <span className="ps-logo-word">PaySheet</span>
      </span>
      {onCart ? (
        <button className="ps-cart-pill" onClick={onCart} aria-expanded={cartOpen} title={`Cart at ${merchant}`}>
          <span aria-hidden>🛒</span> {total} <span className="ps-caret" aria-hidden>{cartOpen ? "▴" : "▾"}</span>
        </button>
      ) : (
        <span className="ps-cart-pill static">{total}</span>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="ps-footer">
      <span>Demo checkout · no real payment is made</span>
    </footer>
  );
}

function Field({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className="ps-field">
      <span>{label}</span>
      <input value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
    </label>
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
