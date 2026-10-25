# Testing

[`scripts/e2e.ts`](../scripts/e2e.ts) drives the real code from both ends: the
same `startVmSession` the VM page runs, and the same `DeviceClient` the device
page uses. They talk only through RTDB.

```bash
npm run dev        # emulators + app, then in another terminal:
npm run e2e        # against the emulators

npm run dev:live   # app against the real project, then:
npm run e2e:live   # against the real Realtime Database
```

## No sleeps

Nothing in the suite waits for a fixed time. Every step waits for the event it
expects:

| Waiting for | How |
|---|---|
| A paysheet state | `stateWhere(pred)`: resolves on the first snapshot matching `pred` |
| The VM going offline or online | `vmPresence(want)`: resolves on the presence change |
| A callback in flight | `heldCallback()`: resolves when the merchant gate is holding one |
| A VM step | `eventWhere(pred)`: resolves on a matching `VmEvent` |
| A queue draining | `pathEmpty(path)`: resolves when the RTDB path is gone |

Slow merchants are simulated with the response gate instead of delays: the
test holds the merchant's answer and releases it when it chooses. The only
timers that run are the product's own deadlines (the SDK's 10 s callback
deadline, the device's 15 s relay deadline), and the timeout test shortens the
SDK's to 1.5 s.

The whole run is bounded from outside (`timeout` in the shell); a missing event
fails the run instead of hanging it.

## What it covers

| Area | Checks |
|---|---|
| API | distinct sessions and links; unknown codes and sessions rejected |
| One transaction | address → options and tax; merchant rejection leaves state unchanged; callback deadline → `CALLBACK_TIMEOUT` |
| VM view | steps arrive in order (received → triggered → finished → sent); the activity card is correct; the VM paysheet renders with no interactive elements |
| Rules | device can't write state; sessions can't read each other; nobody can list `/shareCodes`, `/sessionIndex`, or `/sessions` |
| Resume | device sees the VM go offline and come back; SDK state survives; `seq` continues; the order completes |
| Takeover | the old tab stands down; the in-flight request fails fast with `INTERRUPTED`; the old tab's late result never reaches the device; presence stays on |
| Concurrency | 8 transactions in parallel; each device ends on its own merchant's order; each VM approved exactly its own order |
| Console | lists every session with the right status and presence; the operator token can't write or read share codes |
| Queues | drained after the run |

The same 43 checks pass against the emulators and against the live database.
Measured on the live database from a US home connection, a device action makes
the full round trip (device → RTDB → VM → merchant → RTDB → device) in about
300 ms with eight sessions running at once.
