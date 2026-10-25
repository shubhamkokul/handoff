"use client";

import { useEffect, useState } from "react";
import { connectAs } from "@/lib/firebase-client";
import { watchSessions } from "@/lib/console-feed";
import type { SessionSummary } from "@/lib/protocol";

const CALLBACK_SHORT: Record<string, string> = {
  onShippingAddressChange: "address callback",
  onShippingOptionsChange: "shipping callback",
  onApprove: "approve callback",
};

// Operator console: launch VM paysheets and jump back into any earlier one.
export default function Console() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Live: the list updates as sessions are created, connect, and complete.
  useEffect(() => {
    let stop = () => {};
    (async () => {
      const res = await fetch("/api/operator-token", { method: "POST" });
      if (!res.ok) throw new Error(`console token failed (${res.status})`);
      const db = await connectAs("operator", (await res.json()).token);
      stop = watchSessions(db, window.location.origin, setSessions);
    })().catch((e) => setError(`${e?.message ?? e}. Are the emulators running? (npm run dev)`));
    return () => stop();
  }, []);

  async function launch() {
    setLaunching(true);
    // Open the tab synchronously so popup blockers allow it, then point it at the session.
    const tab = window.open("about:blank", "_blank");
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      if (!res.ok) throw new Error(`launch failed (${res.status})`);
      const { sid } = await res.json();
      if (tab) tab.location.href = `/vm/${sid}`;
      else window.location.href = `/vm/${sid}`;
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    } finally {
      setLaunching(false);
    }
  }

  const live = sessions?.filter((s) => s.status === "waiting" || s.status === "active").length ?? 0;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Handoff</h1>
        <p className="muted">
          Each launch boots a simulated VM paysheet with its own cart and its own device link. Hand links to different
          people to run transactions in parallel; reopen any session to resume it.
        </p>
      </div>

      <div className="toolbar">
        <button className="primary launch" onClick={launch} disabled={launching}>
          {launching ? "Launching…" : "Launch VM paysheet ↗"}
        </button>
        <span className="muted small">
          {sessions ? `${sessions.length} sessions · ${live} in progress` : "Loading…"}
        </span>
      </div>

      {error && <div className="error">{error}</div>}

      {sessions && sessions.length === 0 && (
        <div className="panel empty">
          <p className="muted">No sessions yet. Launch one to get a VM paysheet and a device link.</p>
        </div>
      )}

      {sessions && sessions.length > 0 && (
        <div className="sessions">
          {sessions.map((s) => {
            const closed = s.status === "expired";
            return (
              <div key={s.sid} className={`session ${closed ? "closed" : ""}`}>
                <div className="session-main">
                  <div className="session-title">
                    <strong>{s.label}</strong>
                    <span className={`status ${s.status}`}>{s.status}</span>
                  </div>
                  <div className="session-meta muted small">
                    <span>{new Date(s.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                    {s.total !== null && (
                      <span>{new Intl.NumberFormat("en-US", { style: "currency", currency: s.currency }).format(s.total)}</span>
                    )}
                    <span className={`presence ${s.vmOnline ? "on" : ""}`}>VM</span>
                    <span className={`presence ${s.deviceOnline ? "on" : ""}`}>device</span>
                    {s.busy && <span className="busy-pill">{CALLBACK_SHORT[s.busy] ?? s.busy}…</span>}
                  </div>
                </div>
                {!closed && (
                  <div className="session-actions">
                    <a className="button secondary small" href={`/vm/${s.sid}`} target="_blank" rel="noreferrer">
                      {s.vmOnline ? "VM ↗" : "Resume VM ↗"}
                    </a>
                    <a className="button secondary small" href={s.shareUrl} target="_blank" rel="noreferrer">
                      Device ↗
                    </a>
                    <button
                      className="ghost small"
                      onClick={() => {
                        navigator.clipboard.writeText(s.shareUrl);
                        setCopied(s.sid);
                      }}
                      onMouseLeave={() => setCopied(null)}
                      onBlur={() => setCopied(null)}
                    >
                      {copied === s.sid ? "Copied" : "Copy link"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
