"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { connectAs } from "@/lib/firebase-client";
import { startVmSession } from "@/lib/vm-session";
import { ResponseGate } from "@/lib/response-gate";
import type { CallbackName, PaySheetState } from "@/lib/protocol";
import { VmActivity, reduceActivity, type ActivityCard } from "@/components/VmActivity";

const STATUS_LABEL: Record<PaySheetState["status"], string> = {
  open: "checkout open",
  approved: "paid",
  cancelled: "cancelled",
};

// Simulates the headless VM for one session. The paysheet itself isn't shown:
// nobody looks at it in a real VM. What matters is the relay, so this page
// shows each message in and out, and the merchant callback it triggered.
export default function VmPage({ params }: { params: Promise<{ sid: string }> }) {
  const { sid } = use(params);
  const [cards, setCards] = useState<ActivityCard[]>([]);
  const [status, setStatus] = useState<PaySheetState["status"] | null>(null);
  const [label, setLabel] = useState<string>("");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [deviceOnline, setDeviceOnline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [standby, setStandby] = useState(false);
  const [copied, setCopied] = useState(false);
  const gateRef = useRef(new ResponseGate());
  const [gate, setGate] = useState<{ holding: boolean; pending: CallbackName[] }>({ holding: false, pending: [] });

  useEffect(() => {
    const g = gateRef.current;
    return g.subscribe(() => setGate({ holding: g.isHolding, pending: g.pending }));
  }, []);

  useEffect(() => {
    let cleanup = () => {};
    (async () => {
      const res = await fetch(`/api/sessions/${sid}/vm-token`, { method: "POST" });
      if (res.status === 404) throw new Error("Unknown session.");
      if (res.status === 410) throw new Error("This session has expired.");
      if (!res.ok) throw new Error(`Couldn't open session (${res.status}).`);
      const { vmToken, shareUrl, label } = await res.json();
      setLabel(label);
      document.title = `VM ${label}`;

      const db = await connectAs("vm", vmToken);
      const session = await startVmSession({
        db,
        sid,
        log: () => {},
        beforeMerchantResponds: gateRef.current.wait,
        onState: (s) => setStatus(s.status),
        onEvent: (e) => setCards((prev) => reduceActivity(prev, e)),
        onDevicePresence: setDeviceOnline,
        onTakenOver: () => setStandby(true),
      });

      setShareUrl(shareUrl);
      const onUnload = () => session.stop();
      window.addEventListener("beforeunload", onUnload);
      cleanup = () => {
        window.removeEventListener("beforeunload", onUnload);
        session.stop();
      };
    })().catch((e) => setError(String(e?.message ?? e)));
    return () => cleanup();
  }, [sid]);

  return (
    <main className="page">
      <div className="page-head">
        <Link href="/" className="small">← All sessions</Link>
        <div className="title-row">
          <span className="tag vm">VM</span>
          <h1>{label || "Headless checkout"}</h1>
        </div>
        <div className="vm-status">
          <span className={`presence ${deviceOnline ? "on" : ""}`}>{deviceOnline ? "device connected" : "waiting for device"}</span>
          {status && <span className={`status ${status === "approved" ? "complete" : status === "cancelled" ? "cancelled" : "active"}`}>{STATUS_LABEL[status]}</span>}
        </div>
        <p className="muted">
          The checkout SDK runs here, on infra the user can&apos;t reach, and nobody interacts with it. Below is every
          message relayed between this VM and the user&apos;s device, and the merchant callback each one triggered.
        </p>
      </div>

      {error && <div className="error">{error}</div>}
      {standby && (
        <div className="warn">
          This session was opened in another VM tab, which now owns the SDK. This tab has stopped.{" "}
          <button className="small" onClick={() => location.reload()}>Take it back</button>
        </div>
      )}

      <div className="grid">
        <div className="col">
          <div className="panel">
            <div className="panel-head">
              <h2>Relay steps</h2>
              <span className="muted small">newest first</span>
            </div>
            <VmActivity cards={cards} heldCallbacks={gate.pending} />
          </div>
        </div>

        <div className="col">
          <div className="panel">
            <h2>Device link</h2>
            {shareUrl ? (
              <>
                <div className="share">
                  <code>{shareUrl}</code>
                </div>
                <div className="row-actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      navigator.clipboard.writeText(shareUrl);
                      setCopied(true);
                    }}
                    onMouseLeave={() => setCopied(false)}
                    onBlur={() => setCopied(false)}
                  >
                    {copied ? "Copied" : "Copy link"}
                  </button>
                  <a className="button secondary" href={shareUrl} target="_blank" rel="noreferrer">Open as device ↗</a>
                </div>
              </>
            ) : (
              !error && <p className="muted">Connecting…</p>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Merchant simulator</h2>
              <label className="toggle small">
                <input
                  type="checkbox"
                  checked={gate.holding}
                  onChange={(e) => gateRef.current.setHolding(e.target.checked)}
                />
                Hold responses
              </label>
            </div>
            <p className="muted small">Stands in for the merchant&apos;s backend, not the paysheet.</p>
            {gate.holding ? (
              gate.pending.length > 0 ? (
                <div className="held">
                  <span>
                    Holding <code>{gate.pending.join(", ")}</code>. The device is waiting.
                  </span>
                  <button className="secondary small" onClick={() => gateRef.current.releaseAll()}>Respond now</button>
                </div>
              ) : (
                <p className="muted small">The next callback will wait until you respond. Past 10 s the SDK times it out.</p>
              )
            ) : (
              <p className="muted small">Callbacks answer immediately.</p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
