"use client";

import type { Address, CallbackName, PaySheetState } from "@/lib/protocol";
import type { VmEvent } from "@/lib/vm-bridge";
import { formatMoney } from "./format";

// One card per device request, showing what the VM did with it:
// received → merchant callback triggered → resolved/rejected → result sent.
export interface ActivityCard {
  id: string;
  action: string | null; // null: request inherited from a previous VM tab
  payload: unknown;
  receivedAt: number;
  callback: CallbackName | null;
  triggeredAt: number | null;
  finished: { ts: number; status: "resolved" | "rejected"; reason: string | null; state: PaySheetState } | null;
  sentAt: number | null;
}

export function reduceActivity(cards: ActivityCard[], e: VmEvent): ActivityCard[] {
  const i = cards.findIndex((c) => c.id === e.id);
  const card: ActivityCard =
    i >= 0
      ? { ...cards[i] }
      : { id: e.id, action: null, payload: null, receivedAt: e.ts, callback: null, triggeredAt: null, finished: null, sentAt: null };

  switch (e.kind) {
    case "received":
      Object.assign(card, { action: e.action, payload: e.payload, receivedAt: e.ts });
      break;
    case "callback_triggered":
      Object.assign(card, { callback: e.callback, triggeredAt: e.ts });
      break;
    case "callback_finished":
      card.callback ??= e.callback;
      card.finished = { ts: e.ts, status: e.status, reason: e.reason, state: e.state };
      break;
    case "result_sent":
      card.sentAt = e.ts;
      break;
  }
  return i >= 0 ? cards.map((c, j) => (j === i ? card : c)) : [card, ...cards];
}

const ACTION_LABEL: Record<string, string> = {
  set_shipping_address: "Shipping address",
  select_shipping_option: "Shipping option",
  approve: "Pay",
  cancel: "Cancel",
};

export function VmActivity({ cards, heldCallbacks }: { cards: ActivityCard[]; heldCallbacks: CallbackName[] }) {
  if (cards.length === 0) {
    return (
      <div className="activity-empty muted">
        Nothing yet. The VM paysheet only changes when the device sends something: an address, a shipping choice, Pay,
        or Cancel.
      </div>
    );
  }
  return (
    <div className="activity">
      {cards.map((c) => (
        <Card key={c.id} c={c} held={!!c.callback && !c.finished && heldCallbacks.includes(c.callback)} />
      ))}
    </div>
  );
}

function Card({ c, held }: { c: ActivityCard; held: boolean }) {
  const rel = (ts: number | null) => (ts === null ? "" : `+${ts - c.receivedAt} ms`);
  const isCancel = c.action === "cancel";
  const open = !c.sentAt;

  return (
    <div className={`card ${open ? "open" : ""} ${c.finished?.status === "rejected" ? "rejected" : ""}`}>
      <div className="card-head">
        <strong>{c.action ? ACTION_LABEL[c.action] ?? c.action : "Request from a previous VM tab"}</strong>
        <span className="muted small">{new Date(c.receivedAt).toLocaleTimeString([], { hour12: false })}</span>
      </div>
      {c.action && <div className="card-sub">{describePayload(c.action, c.payload, c.finished?.state)}</div>}

      <ol className="steps">
        {c.action && <Step done label="Received from device" time="+0 ms" />}

        {isCancel ? (
          c.finished && <Step done label={<>SDK <code>onCancel</code> fired; paysheet closed</>} time={rel(c.finished.ts)} />
        ) : c.callback ? (
          <>
            {c.triggeredAt !== null && (
              <Step done label={<>Merchant callback <code>{c.callback}</code> triggered</>} time={rel(c.triggeredAt)} />
            )}
            {c.finished ? (
              <Step
                done
                bad={c.finished.status === "rejected"}
                label={
                  c.finished.status === "resolved"
                    ? <>Callback resolved{summarize(c.callback, c.finished.state) && <> · {summarize(c.callback, c.finished.state)}</>}</>
                    : <>Callback rejected · <code>{c.finished.reason}</code></>
                }
                time={rel(c.finished.ts)}
              />
            ) : (
              <Step pending label={held ? "Merchant is holding its response (see Merchant simulator)" : "Waiting for merchant…"} />
            )}
          </>
        ) : null}

        {c.finished &&
          (c.sentAt ? (
            <Step done label="Result and updated paysheet sent to device" time={rel(c.sentAt)} />
          ) : (
            <Step pending label="Sending result to device…" />
          ))}
      </ol>
    </div>
  );
}

function Step({ label, time, done, pending, bad }: { label: React.ReactNode; time?: string; done?: boolean; pending?: boolean; bad?: boolean }) {
  return (
    <li className={`step ${done ? "done" : ""} ${pending ? "pending" : ""} ${bad ? "bad" : ""}`}>
      <span className="step-mark">{pending ? <span className="spinner sm" /> : bad ? "✕" : "✓"}</span>
      <span className="step-label">{label}</span>
      {time && <span className="step-time">{time}</span>}
    </li>
  );
}

function describePayload(action: string, payload: unknown, state?: PaySheetState) {
  if (action === "set_shipping_address") {
    const a = payload as Address;
    return `${a.line1}, ${a.city}, ${a.state} ${a.postalCode}, ${a.countryCode}`;
  }
  if (action === "select_shipping_option") {
    const id = (payload as { optionId: string }).optionId;
    return state?.shippingOptions.find((o) => o.id === id)?.label ?? id;
  }
  if (action === "approve") return "User tapped Pay on the device";
  if (action === "cancel") return "User cancelled on the device";
  return null;
}

function summarize(callback: CallbackName, s: PaySheetState) {
  const money = (n: number) => formatMoney(n, s.currency);
  if (callback === "onShippingAddressChange")
    return `${s.shippingOptions.length} shipping option${s.shippingOptions.length === 1 ? "" : "s"}, tax ${money(s.tax)}, total ${money(s.total)}`;
  if (callback === "onShippingOptionsChange") return `total now ${money(s.total)}`;
  if (callback === "onApprove") return `order ${s.orderId} approved`;
  return null;
}
