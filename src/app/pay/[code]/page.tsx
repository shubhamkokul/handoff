"use client";

import { use, useEffect, useRef, useState } from "react";
import { connectAs } from "@/lib/firebase-client";
import { createChannel } from "@/lib/channel";
import { DeviceClient } from "@/lib/device-client";
import {
  normalizePaySheet,
  type DeviceAction,
  type PaySheetState,
  type ToDeviceMessage,
  type ToVmMessage,
} from "@/lib/protocol";
import { EventLog, PaySheetView, useLog } from "@/components/PaySheetView";

// The user's device. Renders VM snapshots; every interaction is a request to
// the VM, which fires the real SDK callback and reports back.
export default function DevicePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [entries, log] = useLog();
  const [state, setState] = useState<PaySheetState | null>(null);
  const [vmOnline, setVmOnline] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const clientRef = useRef<DeviceClient | null>(null);

  useEffect(() => {
    let cleanup = () => {};
    (async () => {
      const res = await fetch("/api/sessions/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) throw new Error(res.status === 404 ? "This checkout link has expired." : `Couldn't open checkout (${res.status}).`);
      const { sid, deviceToken } = await res.json();

      const db = await connectAs("device", deviceToken);
      const channel = createChannel<ToVmMessage, ToDeviceMessage>(db, sid, "device");
      const client = new DeviceClient(channel, log);
      clientRef.current = client;

      let lastSeq = 0;
      const unsubState = channel.onState((snap) => {
        if (!snap?.paysheet || snap.seq < lastSeq) return; // ignore stale/malformed snapshots
        lastSeq = snap.seq;
        setState(normalizePaySheet(snap.paysheet));
      });
      const unsubPresence = channel.onPeerPresence(setVmOnline);
      log("info", "connected to VM session");

      cleanup = () => {
        unsubState();
        unsubPresence();
        client.close();
        channel.close();
      };
    })().catch((e) => setError(String(e?.message ?? e)));
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  async function send(action: DeviceAction) {
    if (!clientRef.current) return;
    setInFlight(true);
    setError(null);
    try {
      const outcome = await clientRef.current.request(action);
      if (outcome.status === "rejected" && outcome.reason.startsWith("RELAY")) {
        setError("Lost contact with checkout. Try again.");
      }
    } finally {
      setInFlight(false);
    }
  }

  return (
    <main className="ps-page">
      {state ? (
        <PaySheetView
          state={state}
          disabled={inFlight || !vmOnline}
          notice={
            !vmOnline && state.status === "open"
              ? "Reconnecting to checkout…"
              : error
          }
          handlers={{
            onSetAddress: (a) => send({ action: "set_shipping_address", payload: a }),
            onSelectOption: (optionId) => send({ action: "select_shipping_option", payload: { optionId } }),
            onApprove: () => send({ action: "approve", payload: null }),
            onCancel: () => send({ action: "cancel", payload: null }),
          }}
        />
      ) : (
        <div className="ps-card ps-loading">
          {error ? <p className="ps-alert">{error}</p> : <><span className="ps-spinner" /><p>Connecting to checkout…</p></>}
        </div>
      )}

      <div className="ps-devtools">
        <button className="ps-link small" onClick={() => setShowLog((v) => !v)}>
          {showLog ? "Hide" : "Show"} relay log
        </button>
        {showLog && <EventLog entries={entries} />}
      </div>
    </main>
  );
}
