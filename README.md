# Handoff

Live at **https://handoff.solutionbyhour.com**

Hand a headless checkout to a real person. An agent's checkout paysheet runs in
a VM the user can't reach; Handoff mirrors it onto the user's own device.
The SDK (and its callbacks) stay in the VM; the device sends semantic actions,
the VM fires the real callbacks, and results + state stream back.

```
Device UI (/pay/[code])  ⇄  Firebase RTDB sessions/{sid}  ⇄  VM paysheet + SDK (/vm)
```

**How it works:** see [`architecture/`](architecture/README.md): components,
protocol, data model and security, session lifecycle, deployment, and testing,
with diagrams.

## Run

```bash
npm install
npm run dev          # Firebase emulators (auth, RTDB, UI :4000) + Next on :3000
npm run e2e          # in another terminal: full relay test against the emulators
```

Open http://localhost:3000 (the session console). **Launch VM paysheet** boots a
new session with its own cart and device link, in a new tab. The console updates
live; reopen any session's VM to resume it, or hand its device link to someone
else to run transactions in parallel. To use a real phone, open the console via
your LAN IP so the links point there.

The VM page is display-only, like a real headless VM: nothing on its paysheet is
clickable. It waits for the device, and its **Activity** timeline shows each
request: received from device → merchant callback triggered → resolved or
rejected (with what changed) → result sent to device. The **Merchant simulator**
panel stands in for the merchant's backend: **Hold responses** makes callbacks
wait for you, so you can watch the device wait. Hold one past 10 s and the SDK
times it out. Try SF (3 options + CA tax), Honolulu (express only), and Toronto
or ZIP 00000 (merchant rejects).

Resume and ownership: the VM rebuilds the SDK from the last persisted snapshot.
Opening a session in a second VM tab takes it over (newest wins). The old tab
stands down, and any callback it had in flight fails on the device with
`INTERRUPTED` instead of hanging.

## How it works

| File | Role |
|---|---|
| `src/lib/protocol.ts` | Wire types. Transport-agnostic. |
| `src/lib/channel.ts` | **Only** file that knows about RTDB: queues, presence, state. Swap for WebSockets/Cloud Run later. |
| `src/lib/mock-paysheet-sdk.ts` | Stand-in for the third-party SDK (PayPal-shaped `onShippingAddressChange` / `onShippingOptionsChange` / `onApprove`, `actions.reject`, callback timeout). |
| `src/lib/merchant.ts` | Merchant's callback implementations. |
| `src/lib/vm-bridge.ts` | VM side: device action → SDK call → callback fires → `callback_result` back. Publishes full state snapshots on every change. |
| `src/lib/device-client.ts` | Device side: request/response with correlation ids and a relay timeout. |
| `src/app/api/sessions` | Creates a session (cart, initial state, share link). |
| `src/app/api/sessions/[sid]/vm-token` | VM-role token for a new or resumed session. |
| `src/app/api/operator-token` | Read-only console token (demo: unauthenticated). |
| `src/app/api/sessions/redeem` | Exchanges the share code for a device-role token. |
| `src/lib/vm-session.ts` | Boots or resumes the SDK for one session: rehydrate, take the VM lease, bridge. |
| `src/lib/response-gate.ts` | Lets you hold merchant responses by hand (replaces simulated latency). |
| `src/components/VmActivity.tsx` | VM activity timeline, built from the bridge's `VmEvent`s. |
| `src/components/PaySheetMirror.tsx` | The VM's read-only paysheet. |
| `src/lib/console-feed.ts` | Live session list for the console (operator token, read-only). |
| `deploy/` | Dockerfile, compose files, and `deploy.sh` for the VPS. |
| `database.rules.json` | Per-session, per-role access. Device can't write state; nobody reads share codes; the operator token is read-only. |

RTDB layout:

```
sessions/{sid}/meta       { status, createdAt, expiresAt }   (admin creates, VM updates status)
sessions/{sid}/state      { seq, paysheet }                   (VM writes, device renders)
sessions/{sid}/toVm/*     action messages                     (device appends, VM consumes + deletes)
sessions/{sid}/toDevice/* callback_pending / callback_result  (VM appends, device consumes + deletes)
sessions/{sid}/presence   { vm, device }                      (onDisconnect clears)
sessions/{sid}/vmLease    tab id of the VM that owns the SDK
shareCodes/{code}         { sid, expiresAt }                  (admin only)
sessionIndex/{sid}        { code, label, createdAt, ... }     (admin writes, operator reads)
```

Design rules: the VM is the source of truth; the device renders snapshots and
never applies optimistic state. Every action has an id; the VM dedupes by id;
the device times out (15 s) after the SDK would (10 s), so the SDK's verdict wins.
Those two deadlines are the only timers in the code: no sleeps, no polling.

## Live (real Firebase project)

Copy `.env.live.example` to `.env.live` and fill in your project's values (emulator
config is `.env.emulators`; there is no `.env.local`). `.env.live` is gitignored.

```bash
npm run rules:deploy   # push database.rules.json to the project in .env.live
npm run dev:live       # Next against the real project (no emulators)
npm run e2e:live       # same suite, against real RTDB
```

Free tier (Spark): this uses only Realtime Database (1 instance, 100 simultaneous
connections, 1 GB stored, 10 GB/month download) and Firebase Auth custom tokens,
both free. No Cloud Functions, no Identity Platform upgrade. A full `e2e:live`
run opens about 25 connections and writes a few KB.

The server needs a service-account key to mint custom tokens; `.env.live` points
`GOOGLE_APPLICATION_CREDENTIALS` at it (outside the repo).

## Before production

- `POST /api/sessions` must be service-authenticated (it mints VM tokens).
- Share codes: bind to the first device (or make single-use + rely on the device's Firebase session for reloads).
- Cleanup: `npm run cleanup:live` deletes expired sessions by hand. A scheduled Cloud Function would automate it but needs the paid Blaze plan, so the demo doesn't use one. Delete on completion too, since addresses are PII.
- Replace the mock SDK with the real one in the VM: the bridge maps device actions onto whatever drives the real paysheet (e.g. Playwright clicks / SDK test hooks) and listens for callback resolution.
