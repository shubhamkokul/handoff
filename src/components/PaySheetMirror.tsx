"use client";

import type { PaySheetState } from "@/lib/protocol";
import { formatMoney } from "./format";

// The VM's paysheet. Display only: in the VM nobody can interact with it,
// so everything here changes because a device request drove the SDK.
export function PaySheetMirror({ state }: { state: PaySheetState }) {
  const money = (n: number) => formatMoney(n, state.currency);
  const shipping = state.shippingOptions.find((o) => o.selected);
  const a = state.shippingAddress;

  return (
    <div className="sheet mirror">
      <header className="sheet-head">
        <span className="brand">PaySheet</span>
        <span className="muted">{state.merchant}</span>
      </header>

      {state.status === "approved" && (
        <div className="banner ok">Approved · order {state.orderId}</div>
      )}
      {state.status === "cancelled" && <div className="banner bad">Cancelled by the user</div>}
      {state.busy && (
        <div className="banner busy">
          <span className="spinner sm" /> Running <code>{state.busy.callback}</code>
        </div>
      )}

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
        {a ? (
          <p className="field">{a.line1}, {a.city}, {a.state} {a.postalCode}, {a.countryCode}</p>
        ) : (
          <p className="field muted">Waiting for the device to send an address</p>
        )}
      </section>

      <section>
        <h3>Shipping</h3>
        {state.shippingOptions.length === 0 ? (
          <p className="field muted">Options appear after the merchant accepts an address</p>
        ) : (
          state.shippingOptions.map((o) => (
            <div className={`row option-ro ${o.selected ? "selected" : ""}`} key={o.id}>
              <span>{o.selected ? "●" : "○"} {o.label}</span>
              <span>{o.amount === 0 ? "Free" : money(o.amount)}</span>
            </div>
          ))
        )}
      </section>

      <section className="totals">
        <div className="row muted"><span>Shipping</span><span>{money(shipping?.amount ?? 0)}</span></div>
        <div className="row muted"><span>Tax</span><span>{money(state.tax)}</span></div>
        <div className="row total"><span>Total</span><span>{money(state.total)}</span></div>
      </section>

      {state.error && <div className="error">Last callback rejected: {state.error}</div>}
    </div>
  );
}
