# Mobile (Flutter)

The Flutter app is scaffolded with the Flutter CLI rather than committed by
hand, so the generated platform folders (`android/`, `ios/`, …) match your
installed Flutter/SDK versions.

## One-time setup

1. Install Flutter: https://docs.flutter.dev/get-started/install
2. Verify your toolchain:

   ```bash
   flutter doctor
   ```

3. Generate the app **into this folder** (run from the repo root):

   ```bash
   flutter create --org com.websol --project-name websol_crm mobile
   ```

## Run it

```bash
cd mobile
flutter pub get
flutter run
```

## Talking to the backend

Point the app at the local Functions host (`http://localhost:7071/api`) during
development, and at your deployed Azure Functions URL in production. The base URL
lives in one place — `lib/config.dart` (mirrors the `config.ts` pattern in
`/backend`) — and can be overridden at build time:

```bash
flutter run --dart-define=API_BASE_URL=https://<your-app>.azurewebsites.net/api
```

## Field Service app (Module 7)

The app is the **field technician's** tool. After signing in (it reuses Module
1's `/auth/login` JWT), the technician lands on **Today's Tickets** — their
assigned visits for the day, sorted by priority then geography (the device sends
its GPS so the server orders by distance). Tapping a ticket opens the workflow,
where the available buttons follow the ticket's status:

```
ASSIGNED ──En route──▶ IN_TRANSIT ──Check in (GPS)──▶ ON_SITE
   │                       │                              │
   │                       └─ notifies the customer       └─ Start work ─▶ IN_PROGRESS
   │                                                                          │
   └────────────────────── Escalate (any active state) ──────────┐    Meter / Parts / Close
                                                                  ▼
                                                              ESCALATED
```

Key source files:

| File | Responsibility |
|------|----------------|
| `lib/config.dart` | Base URL + storage keys |
| `lib/api_client.dart` | REST calls **and** the offline queue/sync engine |
| `lib/app_state.dart` | Auth + connectivity; auto-syncs when back online |
| `lib/screens/today_screen.dart` | Today's tickets, priority/geo sorted |
| `lib/screens/ticket_detail_screen.dart` | Status-driven action workflow |
| `lib/screens/meter_screen.dart` | Meter capture with photo (BR-004/005/006) |
| `lib/screens/close_screen.dart` | Close with digital signature or OTP |

## How offline sync works (the simple version)

A technician's day often runs through basements and dead zones, so the app
**never blocks on the network**. Here's the whole idea:

1. **Every field action gets a unique ID.** When the technician marks "en
   route", checks in, records a meter reading, logs parts, or closes a ticket,
   the app stamps that action with a random `clientActionId` and the time it
   actually happened.

2. **Online → send it now. Offline → save it.** If there's a connection, the app
   posts the action straight away. If the post fails because there's no signal,
   the action is saved to a small queue in the phone's local storage and the
   technician carries on — nothing is lost, nothing waits.

3. **Back online → replay the queue.** As soon as connectivity returns (the app
   watches for it), the queue is sent in one batch to
   `POST /api/service-tickets/sync`.

4. **Replays are safe.** The server keeps a record of every `clientActionId` it
   has already applied. If a flaky connection causes the same action to be sent
   twice, the second one is recognised and skipped (answered `DUPLICATE`) instead
   of being applied again. This property — *idempotency* — is what makes "do the
   work offline, sync later" trustworthy: you can retry as much as you like and
   the books still balance.

In short: **do the work, the sync takes care of itself.**
