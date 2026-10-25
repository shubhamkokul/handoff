// End-to-end: real VM session code on one side, real DeviceClient on the
// other, talking only through RTDB. No sleeps: every step waits for the event
// it expects (a snapshot, a presence change, a queue draining).
//
//   npm run e2e                       # against the emulators (npm run dev)
//   E2E_TARGET=live npm run e2e       # against the real project in .env.local
import { initializeApp } from "firebase/app";
import { initializeAuth, inMemoryPersistence, connectAuthEmulator, signInWithCustomToken } from "firebase/auth";
import { getDatabase, connectDatabaseEmulator, ref, set, get, goOffline, onValue, type Database } from "firebase/database";
import { createChannel } from "../src/lib/channel";
import { DeviceClient } from "../src/lib/device-client";
import { startVmSession } from "../src/lib/vm-session";
import { ResponseGate } from "../src/lib/response-gate";
import { watchSessions } from "../src/lib/console-feed";
import type { PaySheet } from "../src/lib/mock-paysheet-sdk";
import type { VmEvent } from "../src/lib/vm-bridge";
import { reduceActivity, VmActivity, type ActivityCard } from "../src/components/VmActivity";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  normalizePaySheet,
  type Address,
  type PaySheetState,
  type SessionSummary,
  type ToDeviceMessage,
  type ToVmMessage,
} from "../src/lib/protocol";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const LIVE = process.env.E2E_TARGET === "live";
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "demo-key",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "demo-handoff",
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL ?? "https://demo-handoff-default-rtdb.firebaseio.com",
};
const SF: Address = { line1: "1 Market St", city: "SF", state: "CA", postalCode: "94105", countryCode: "US" };
const AUSTIN: Address = { line1: "500 Congress Ave", city: "Austin", state: "TX", postalCode: "78701", countryCode: "US" };
const quiet = () => {};

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures++;
}

// Resolve once `pred` holds for a value pushed by `subscribe`.
function until<T>(subscribe: (cb: (v: T) => void) => () => void, pred: (v: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    let done = false;
    let unsub: (() => void) | undefined;
    unsub = subscribe((v) => {
      if (done || !pred(v)) return;
      done = true;
      unsub?.();
      resolve(v);
    });
    if (done) unsub();
  });
}
const pathEmpty = (db: Database, path: string) =>
  until<boolean>((cb) => onValue(ref(db, path), (s) => cb(!s.exists())), Boolean);
const sheetWhere = (sheet: PaySheet, pred: (s: PaySheetState) => boolean) =>
  pred(sheet.getState()) ? Promise.resolve(sheet.getState()) : until<PaySheetState>((cb) => sheet.subscribe(cb), pred);

let appCount = 0;
async function connect(token: string): Promise<Database> {
  const app = initializeApp(config, `app-${appCount++}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  const db = getDatabase(app);
  if (!LIVE) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectDatabaseEmulator(db, "127.0.0.1", 9000);
  }
  await signInWithCustomToken(auth, token);
  return db;
}

const post = (path: string, body?: unknown) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function createSession() {
  const s = await (await post("/api/sessions")).json();
  return { ...s, code: s.shareUrl.split("/pay/")[1] as string } as { sid: string; label: string; shareUrl: string; code: string };
}

async function openVm(sid: string, callbackTimeoutMs = 10_000) {
  const { vmToken } = await (await post(`/api/sessions/${sid}/vm-token`)).json();
  const db = await connect(vmToken);
  const gate = new ResponseGate();
  let takenOver = false;
  const events: VmEvent[] = [];
  const eventSubs = new Set<(e: VmEvent) => void>();
  const session = await startVmSession({
    db, sid, log: quiet, callbackTimeoutMs,
    beforeMerchantResponds: gate.wait,
    onEvent: (e) => (events.push(e), eventSubs.forEach((fn) => fn(e))),
    onTakenOver: () => (takenOver = true),
  });
  return {
    db, session, gate, events,
    eventWhere: (pred: (e: VmEvent) => boolean) =>
      events.some(pred) ? Promise.resolve() : until<VmEvent>((cb) => (eventSubs.add(cb), () => eventSubs.delete(cb)), pred).then(() => {}),
    get takenOver() { return takenOver; },
    heldCallback: () => until<number>((cb) => (cb(gate.pending.length), gate.subscribe(() => cb(gate.pending.length))), (n) => n > 0),
    // Simulate the VM tab dying: drop the connection so onDisconnect fires.
    kill() { session.stop(); goOffline(db); },
  };
}

async function openDevice(code: string) {
  const { sid, deviceToken } = await (await post("/api/sessions/redeem", { code })).json();
  const db = await connect(deviceToken);
  const channel = createChannel<ToVmMessage, ToDeviceMessage>(db, sid, "device");
  const history: { seq: number; p: PaySheetState }[] = [];
  const stateSubs = new Set<(p: PaySheetState) => void>();
  channel.onState((s) => {
    if (!s?.paysheet) return;
    const p = normalizePaySheet(s.paysheet);
    history.push({ seq: s.seq, p });
    stateSubs.forEach((fn) => fn(p));
  });
  let vmOnline = false;
  const presenceSubs = new Set<(o: boolean) => void>();
  channel.onPeerPresence((o) => {
    vmOnline = o;
    presenceSubs.forEach((fn) => fn(o));
  });
  const client = new DeviceClient(channel, quiet);

  const dev = {
    db, sid, client, history,
    get vmOnline() { return vmOnline; },
    latest: () => history[history.length - 1].p,
    stateWhere: (pred: (p: PaySheetState) => boolean) =>
      history.length && pred(dev.latest())
        ? Promise.resolve(dev.latest())
        : until<PaySheetState>((cb) => (stateSubs.add(cb), () => stateSubs.delete(cb)), pred),
    vmPresence: (want: boolean) =>
      vmOnline === want ? Promise.resolve(want) : until<boolean>((cb) => (presenceSubs.add(cb), () => presenceSubs.delete(cb)), (o) => o === want),
  };
  await dev.stateWhere(() => true);
  return dev;
}

async function main() {
  console.log(`target: ${LIVE ? `LIVE ${config.databaseURL}` : "emulators"}`);

  // ---------------------------------------------------------------- API
  console.log("\n# API");
  const a = await createSession();
  const b = await createSession();
  check("sessions get distinct links", a.code !== b.code && a.sid !== b.sid);
  check("sessions get distinct labels", a.label !== b.label, [a.label, b.label]);
  check("unknown share code is rejected", (await post("/api/sessions/redeem", { code: "nope-nope-nope" })).status === 404);
  check("unknown session can't get a VM token", (await post(`/api/sessions/does-not-exist/vm-token`)).status === 404);

  // ---------------------------------------------------------------- single flow
  console.log("\n# Single transaction");
  const vmA = await openVm(a.sid, 1500);
  const devA = await openDevice(a.code);
  check("new session is not 'resumed'", !vmA.session.resumed);
  await devA.vmPresence(true);
  check("device sees VM presence", devA.vmOnline);

  let r = await devA.client.request({ action: "set_shipping_address", payload: SF });
  check("address change resolves", r.status === "resolved", r);
  const withOptions = await devA.stateWhere((p) => p.shippingOptions.length > 0);
  check("device sees shipping options + CA tax", withOptions.shippingOptions.length === 3 && withOptions.tax > 0);
  check("device saw busy state during callback", devA.history.some((h) => h.p.busy?.callback === "onShippingAddressChange"));
  // "Sent" is the VM's write being acknowledged; the device may already have the result by then.
  await vmA.eventWhere((e) => e.kind === "result_sent");
  const kinds = vmA.events.map((e) => e.kind);
  check("VM relay steps in order: action in → pending out → callback fired → finished → result out",
    kinds.join(",") === "received,pending_sent,callback_triggered,callback_finished,result_sent", kinds);
  const card = vmA.events.reduce<ActivityCard[]>(reduceActivity, [])[0];
  check("VM activity card shows the callback and its result", card.callback === "onShippingAddressChange" && card.finished?.status === "resolved" && card.sentAt !== null && card.finished.state.shippingOptions.length === 3);
  const html = renderToStaticMarkup(createElement(VmActivity, { cards: [card], heldCallbacks: [] }));
  check("VM view shows relay steps, no paysheet controls",
    !/<(button|input|form|select|textarea|a)\b/.test(html) && ["callback_pending", "callback_result", "onShippingAddressChange", "Device → VM", "VM → Device"].every((t) => html.includes(t)));

  r = await devA.client.request({ action: "set_shipping_address", payload: { ...SF, countryCode: "CA", state: "ON", postalCode: "M5H2N2" } });
  check("foreign address rejected with COUNTRY_ERROR", r.status === "rejected" && r.reason === "COUNTRY_ERROR", r);
  const afterReject = await devA.stateWhere((p) => p.error === "COUNTRY_ERROR");
  check("rejected address not committed", afterReject.shippingAddress?.countryCode === "US");

  // Merchant holds the response past the SDK's 1.5 s deadline.
  vmA.gate.setHolding(true);
  r = await devA.client.request({ action: "select_shipping_option", payload: { optionId: "express" } });
  check("merchant past SDK deadline → CALLBACK_TIMEOUT", r.status === "rejected" && r.reason === "CALLBACK_TIMEOUT", r);
  vmA.gate.setHolding(false); // releases the stale callback; the SDK already gave up on it

  // ---------------------------------------------------------------- rules
  console.log("\n# Rules / isolation");
  const outcome = (p: Promise<unknown>) => p.then(() => "allowed", () => "denied");
  check("device cannot write state", (await outcome(set(ref(devA.db, `sessions/${a.sid}/state`), { seq: 999 }))) === "denied");
  // A denied local write fires optimistically, then is reverted; wait for the revert.
  await devA.stateWhere((p) => !!p.merchant);
  check("session A's device cannot read session B", (await outcome(get(ref(devA.db, `sessions/${b.sid}/state`)))) === "denied");
  check("session A's VM cannot read session B", (await outcome(get(ref(vmA.db, `sessions/${b.sid}/toVm`)))) === "denied");
  for (const path of ["shareCodes", "sessionIndex", "sessions"]) {
    check(`session tokens cannot enumerate /${path}`, (await outcome(get(ref(devA.db, path)))) === "denied");
  }

  // ---------------------------------------------------------------- resume
  console.log("\n# Resume after VM dies");
  const seqBefore = devA.history[devA.history.length - 1].seq;
  vmA.kill();
  await devA.vmPresence(false);
  check("device sees VM go offline", !devA.vmOnline);
  const vmA2 = await openVm(a.sid);
  check("reopened VM reports resumed", vmA2.session.resumed);
  await devA.vmPresence(true);
  check("device sees VM back online", devA.vmOnline);
  const resumedState = vmA2.session.sheet.getState();
  check("SDK state survived (address + options)", resumedState.shippingOptions.length === 3 && !!resumedState.shippingAddress);
  r = await devA.client.request({ action: "select_shipping_option", payload: { optionId: "express" } });
  r = r.status === "resolved" ? await devA.client.request({ action: "approve", payload: null }) : r;
  await devA.stateWhere((p) => p.status === "approved");
  check("transaction completes on resumed VM", r.status === "resolved", r);
  check("snapshot seq continued past the dead VM", devA.history[devA.history.length - 1].seq > seqBefore);

  // ---------------------------------------------------------------- takeover mid-callback
  console.log("\n# Second VM tab takes over mid-callback");
  const vmB = await openVm(b.sid);
  const devB = await openDevice(b.code);
  vmB.gate.setHolding(true);
  const pending = devB.client.request({ action: "set_shipping_address", payload: SF });
  await vmB.heldCallback(); // the callback is now in flight on vmB
  const vmB2 = await openVm(b.sid);
  r = await pending;
  check("old VM tab stood down", vmB.takenOver);
  check("in-flight request fails fast with INTERRUPTED", r.status === "rejected" && r.reason === "INTERRUPTED", r);
  // Let the old tab's merchant answer. Its SDK commits locally, but it must not reach the device.
  vmB.gate.setHolding(false);
  await sheetWhere(vmB.session.sheet, (s) => s.shippingAddress?.city === "SF");
  r = await devB.client.request({ action: "set_shipping_address", payload: AUSTIN });
  check("new owner handles the retry", r.status === "resolved", r);
  await devB.stateWhere((p) => p.shippingAddress?.city === "Austin");
  check("old tab's late result never reached the device", !devB.history.some((h) => h.p.shippingAddress?.city === "SF"));
  check("new owner's SDK has the retry, not the stale result", vmB2.session.sheet.getState().shippingAddress?.city === "Austin");
  check("VM presence stayed on through the takeover", devB.vmOnline);

  // ---------------------------------------------------------------- concurrency
  console.log("\n# Concurrent transactions");
  const N = 8;
  const created = await Promise.all(Array.from({ length: N }, () => createSession()));
  const vms = await Promise.all(created.map((s) => openVm(s.sid)));
  const devs = await Promise.all(created.map((s) => openDevice(s.code)));
  const t0 = Date.now();
  const results = await Promise.all(
    devs.map(async (d) => {
      const steps = [
        await d.client.request({ action: "set_shipping_address", payload: SF }),
        await d.client.request({ action: "select_shipping_option", payload: { optionId: "express" } }),
        await d.client.request({ action: "approve", payload: null }),
      ];
      await d.stateWhere((p) => p.status === "approved");
      return steps.every((s) => s.status === "resolved");
    }),
  );
  const elapsed = Date.now() - t0;
  check(`${N} parallel transactions all resolved`, results.every(Boolean), results);
  check("each device ended on its own merchant's paysheet", devs.every((d, i) => created[i].label.endsWith(d.latest().merchant)));
  check("each VM's SDK approved exactly its own order", vms.every((v, i) => v.session.sheet.getState().orderId === devs[i].latest().orderId));
  console.log(`      (${N} × 3 round trips in ${elapsed} ms, ~${Math.round(elapsed / 3)} ms per round trip)`);

  // ---------------------------------------------------------------- operator console
  console.log("\n# Operator console (live)");
  const { token } = await (await post("/api/operator-token")).json();
  const opDb = await connect(token);
  const all = [a, b, ...created];
  const done = new Set([a, ...created].map((s) => s.sid));
  const list = await until<SessionSummary[]>(
    (cb) => watchSessions(opDb, BASE, cb),
    (ss) => {
      const m = new Map(ss.map((s) => [s.sid, s]));
      return all.every((s) => m.has(s.sid)) && [...done].every((sid) => m.get(sid)?.status === "complete") && !!m.get(b.sid)?.vmOnline;
    },
  );
  const byId = new Map(list.map((s) => [s.sid, s]));
  check("console lists every session", all.every((s) => byId.has(s.sid)));
  check("completed sessions show complete", [...done].every((sid) => byId.get(sid)?.status === "complete"));
  check("in-progress session shows active + online", byId.get(b.sid)?.status === "active" && byId.get(b.sid)?.vmOnline === true);
  check("operator cannot write", (await outcome(set(ref(opDb, `sessions/${a.sid}/state`), { seq: 1 }))) === "denied");
  check("operator cannot read share codes", (await outcome(get(ref(opDb, "shareCodes")))) === "denied");

  // ---------------------------------------------------------------- queues
  await Promise.all([pathEmpty(vmA2.db, `sessions/${a.sid}/toVm`), pathEmpty(vmA2.db, `sessions/${a.sid}/toDevice`)]);
  check("message queues drained", true);

  console.log(failures ? `\n${failures} failed` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
