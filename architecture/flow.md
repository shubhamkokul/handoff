# End-to-end flow

The whole journey, from the agent getting stuck to the agent finishing the
checkout. Everything starts in the VM.

## When the agent falls back

```mermaid
flowchart TD
    A["Agent opens the merchant checkout<br/>SDK renders the paysheet in the VM"] --> B["Agent fills in what it knows:<br/>cart, saved preferences"]
    B --> C{"Can the agent finish<br/>on its own?"}
    C -- yes --> D["Agent completes checkout<br/>(no handoff)"]
    C -- "no: needs the user" --> E["Trigger fallback:<br/>create a Handoff session"]
    E --> F["Send the fallback URL to the user"]
    F --> G["User finishes on their device<br/>while the SDK stays in the VM"]
    G --> H{"Outcome"}
    H -- "paid" --> I["onApprove resolved in the VM<br/>agent resumes and confirms the order"]
    H -- "cancelled" --> J["onCancel fired in the VM<br/>agent tells the user, stops"]
    H -- "link expired" --> K["No answer in time<br/>agent reports it couldn't finish"]
```

Typical reasons to fall back:

- The agent doesn't know where to ship, or the address it has is rejected.
- The buyer has to choose between shipping options or prices.
- The buyer has to approve the payment themselves (consent, step-up, policy).

## The full sequence

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Agent as Agent (in VM)
    participant VM as VM paysheet + SDK
    participant M as Merchant callbacks
    participant API as Handoff server
    participant DB as Firebase RTDB
    participant Dev as Device paysheet

    rect rgba(120, 120, 120, 0.08)
    Note over Agent,M: Phase 1: the agent gets stuck
    Agent->>VM: Open merchant checkout, SDK renders the paysheet
    Agent->>VM: Fill in what it can (cart, known details)
    Note over Agent: Can't finish: needs the user's<br/>address, choice, or approval
    end

    rect rgba(120, 120, 120, 0.08)
    Note over Agent,API: Phase 2: fallback
    Agent->>API: POST /api/sessions (request a fallback)
    API->>DB: Create session: meta waiting, initial snapshot, share code
    API-->>Agent: Fallback URL /pay/{code}
    Agent->>VM: Start the Handoff bridge for this session
    VM->>API: POST /api/sessions/{sid}/vm-token
    API-->>VM: VM token
    VM->>DB: Sign in, take the VM lease, set presence/vm
    VM->>DB: Snapshot (seq 1), listen on toVm
    Agent-->>User: "Please finish your checkout" + fallback URL
    end

    rect rgba(120, 120, 120, 0.08)
    Note over User,Dev: Phase 3: the user joins
    User->>Dev: Open the fallback URL
    Dev->>API: POST /api/sessions/redeem {code}
    API->>DB: meta: waiting → active
    API-->>Dev: Device token
    Dev->>DB: Sign in, subscribe to state, presence, toDevice
    DB-->>Dev: Latest snapshot: render the paysheet
    DB-->>VM: presence/device = true
    end

    rect rgba(120, 120, 120, 0.08)
    Note over User,Dev: Phase 4: relay loop (repeats for each interaction)
    loop Each user interaction (address, shipping option)
        User->>Dev: e.g. enter a shipping address
        Dev->>DB: toVm: action set_shipping_address {id}
        DB-->>VM: action
        VM->>DB: toDevice: callback_pending {ref: id}
        DB-->>Dev: Show "Checking your address…"
        VM->>M: onShippingAddressChange(address)
        alt merchant accepts
            M-->>VM: Shipping options and tax
            VM->>DB: Snapshot: address, options, total
            VM->>DB: toDevice: callback_result resolved
        else merchant rejects
            M-->>VM: actions.reject(COUNTRY_ERROR)
            VM->>DB: Snapshot: unchanged, error set
            VM->>DB: toDevice: callback_result rejected
        end
        DB-->>Dev: Render the new snapshot and the result
    end
    end

    rect rgba(120, 120, 120, 0.08)
    Note over User,Agent: Phase 5: approval, and back to the agent
    User->>Dev: Tap Pay
    Dev->>DB: toVm: action approve {id}
    DB-->>VM: approve
    VM->>DB: toDevice: callback_pending {ref: id}
    VM->>M: onApprove(orderId)
    M-->>VM: Order captured
    VM->>DB: Snapshot: approved, order id
    VM->>DB: toDevice: callback_result resolved
    VM->>DB: meta: complete
    DB-->>Dev: "You paid $83.63"
    VM-->>Agent: SDK onApprove resolved: checkout complete
    Agent-->>User: Order confirmation
    end
```

What to notice:

- **The agent never leaves the VM, and neither does the SDK.** The user's
  device only sends intents and renders snapshots. The merchant sees one
  continuous checkout session.
- **The agent learns the outcome locally.** `onApprove` resolves inside the VM,
  in the same SDK instance the agent was driving, so no extra signal is needed
  to resume. `meta/status` also turns `complete` for anything watching from
  outside (the console, an orchestrator).
- **The fallback URL carries no secrets.** It holds an opaque code; the device
  exchanges it for a short-lived, session-scoped token over HTTPS.
- **Firebase carries the realtime traffic.** The Handoff server only creates
  the session and mints tokens. It never relays messages.

## Failure paths

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Agent as Agent (in VM)
    participant VM as VM paysheet + SDK
    participant DB as Firebase RTDB
    participant Dev as Device paysheet

    alt User never opens the link
        Agent-->>User: Fallback URL
        Note over DB: Session expires (2 h by default)
        Agent-->>User: "I couldn't finish your checkout"
    else User cancels
        User->>Dev: Cancel and return to merchant
        Dev->>DB: toVm: action cancel
        DB-->>VM: cancel
        VM->>VM: SDK onCancel fires
        VM->>DB: Snapshot: cancelled
        VM->>DB: callback_result resolved, meta: cancelled
        DB-->>Dev: "Checkout cancelled"
        VM-->>Agent: Checkout cancelled by the user
    else Merchant is too slow
        Dev->>DB: toVm: action {id}
        DB-->>VM: action
        Note over VM: Merchant callback runs past 10 s
        VM->>DB: callback_result rejected CALLBACK_TIMEOUT
        DB-->>Dev: "The merchant is taking too long. Try again."
    else The VM restarts mid-checkout
        Note over VM: VM process dies
        DB-->>Dev: presence/vm removed: "Reconnecting to checkout…"
        VM->>DB: New VM reads the last snapshot, takes the lease
        VM->>DB: callback_result INTERRUPTED for any orphaned request
        DB-->>Dev: VM back with the same paysheet, the user retries
    end
```

Each of these is covered by the [end-to-end tests](testing.md), except the
expiry path, which only needs the clock to pass `expiresAt`.
