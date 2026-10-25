"use client";

import type { Address, CallbackName, PaySheetState } from "@/lib/protocol";
import type { VmEvent } from "@/lib/vm-bridge";
import { formatMoney } from "./format";

// One card per device request: the relay messages in and out of the VM, and
// the merchant callback the VM ran in between.
export interface ActivityCard {
  id: string;
  action: string | null; // null: request inherited from a previous VM tab
  payload: unknown;
  receivedAt: number;
  callback: CallbackName | null;
  pendingSentAt: number | null;
  triggeredAt: number | null;
  finished: { ts: number; status: "resolved" | "rejected"; reason: string | null; state: PaySheetState } | null;
  sentAt: number | null;
}

export function reduceActivity(cards: ActivityCard[], e: VmEvent): ActivityCard[] {
  const i = cards.findIndex((c) => c.id === e.id);
  const card: ActivityCard =
    i >= 0
      ? { ...cards[i] }
      : { id: e.id, action: null, payload: null, receivedAt: e.ts, callback: null, pendingSentAt: null, triggeredAt: null, finished: null, sentAt: null };

  switch (e.kind) {
    case "received":
      Object.assign(card, { action: e.action, payload: e.payload, receivedAt: e.ts });
      break;
    case "pending_sent":
      Object.assign(card, { callback: e.callback, pendingSentAt: e.ts });
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

type Dir = "in" | "out" | "vm";
const DIR_LABEL: Record<Dir, string> = { in: "Device → VM", out: "VM → Device", vm: "In the VM" };

export function VmActivity({ cards, heldCallbacks }: { cards: ActivityCard[]; heldCallbacks: CallbackName[] }) {
  if (cards.length === 0) {
    return (
      <div className="activity-empty muted">
        Waiting for the device. Every message the device sends shows up here, along with the merchant callback it
        triggers and the result sent back.
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
  const rel = (ts: number | null) => (ts === null ? undefined : `+${ts - c.receivedAt} ms`);
  const isCancel = c.action === "cancel";

  return (
    <div className={`card ${!c.sentAt ? "open" : ""} ${c.finished?.status === "rejected" ? "rejected" : ""}`}>
      <div className="card-head">
        <code className="card-id">{c.id}</code>
        <span className="muted small">{new Date(c.receivedAt).toLocaleTimeString([], { hour12: false })}</span>
      </div>

      <ol className="steps">
        {c.action ? (
          <Step dir="in" time="+0 ms" title={<>action <code>{c.action}</code></>} detail={describePayload(c.action, c.payload)} />
        ) : (
          <Step dir="vm" title="Request left over from a previous VM tab" />
        )}

        {c.pendingSentAt !== null && c.callback && (
          <Step dir="out" time={rel(c.pendingSentAt)} title={<><code>callback_pending</code> {c.callback}</>} detail="Device shows its spinner" />
        )}

        {isCancel
          ? c.finished && <Step dir="vm" time={rel(c.finished.ts)} title={<>SDK fired <code>onCancel</code></>} detail="Paysheet closed" />
          : c.triggeredAt !== null &&
            c.callback && (
              <Step dir="vm" time={rel(c.triggeredAt)} title={<>SDK fired merchant callback <code>{c.callback}</code></>} />
            )}

        {!isCancel && c.callback && (
          c.finished ? (
            <Step
              dir="vm"
              time={rel(c.finished.ts)}
              bad={c.finished.status === "rejected"}
              title={c.finished.status === "resolved" ? "Merchant resolved" : <>Merchant rejected <code>{c.finished.reason}</code></>}
              detail={c.finished.status === "resolved" ? summarize(c.callback, c.finished.state) : null}
            />
          ) : (
            c.triggeredAt !== null && (
              <Step dir="vm" pending title={held ? "Merchant is holding its response" : "Waiting for the merchant…"} />
            )
          )
        )}

        {c.finished &&
          (c.sentAt ? (
            <Step
              dir="out"
              time={rel(c.sentAt)}
              bad={c.finished.status === "rejected"}
              title={<><code>callback_result</code> {c.finished.status}</>}
              detail="Plus the updated paysheet snapshot"
            />
          ) : (
            <Step dir="out" pending title={<>Sending <code>callback_result</code>…</>} />
          ))}
      </ol>
    </div>
  );
}

function Step({
  dir,
  title,
  detail,
  time,
  pending,
  bad,
}: {
  dir: Dir;
  title: React.ReactNode;
  detail?: React.ReactNode;
  time?: string;
  pending?: boolean;
  bad?: boolean;
}) {
  return (
    <li className={`step ${pending ? "pending" : ""} ${bad ? "bad" : ""}`}>
      <span className="step-mark">{pending ? <span className="spinner sm" /> : bad ? "✕" : "✓"}</span>
      <span className={`dir dir-${dir}`}>{DIR_LABEL[dir]}</span>
      <span className="step-body">
        <span className="step-title">{title}</span>
        {detail && <span className="step-detail">{detail}</span>}
      </span>
      <span className="step-time">{time}</span>
    </li>
  );
}

function describePayload(action: string, payload: unknown) {
  if (action === "set_shipping_address") {
    const a = payload as Address;
    return `${a.city}, ${a.state} ${a.postalCode}, ${a.countryCode}`;
  }
  if (action === "select_shipping_option") return `option: ${(payload as { optionId: string }).optionId}`;
  if (action === "approve") return "User tapped Pay";
  if (action === "cancel") return "User cancelled";
  return null;
}

function summarize(callback: CallbackName, s: PaySheetState) {
  const money = (n: number) => formatMoney(n, s.currency);
  if (callback === "onShippingAddressChange")
    return `${s.shippingOptions.length} shipping option${s.shippingOptions.length === 1 ? "" : "s"}, tax ${money(s.tax)}`;
  if (callback === "onShippingOptionsChange") return `total ${money(s.total)}`;
  if (callback === "onApprove") return `order ${s.orderId}`;
  return null;
}
