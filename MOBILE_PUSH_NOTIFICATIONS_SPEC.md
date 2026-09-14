# Mobile Push Notifications — Backend Spec (task #12, backend half)

Goal: deliver **remote** push notifications to the Stewardex mobile app (Expo)
when server-side events happen (an approval is routed to you, a meeting is
created, a new chat message, reminders) — even when the app is **closed**.

FCM/APNs and the Expo push credential are configured on the **EAS build + Expo
side** (see `st-mobile` / `MOBILE_PUSH_NOTIFICATIONS` setup). **The backend does
NOT talk to FCM directly.** It only:

1. **Stores** each user's Expo push token(s), and
2. **POSTs** to **Expo's Push API** (`https://exp.host/--/api/v2/push/send`).
   Expo then relays to FCM (Android) / APNs (iOS) using the credentials already
   uploaded to the Expo project.

So there are **no Firebase secrets in the backend**. (Optional: an
`EXPO_ACCESS_TOKEN` for higher rate limits / enhanced security — see §7.)

---

## 1. Architecture fit

- Tokens are **per-user, per-device** → a user can have several. Users live in
  the **tenant DB**, so store tokens in the tenant DB too (schema in
  `src/db/schemas/platform/`, repo constructed per-request with `req.tenantDb`,
  exactly like every other module).
- Routes go under `routes/platform/` behind `authAndResolveTenant`.
- The **sender is a service** (`services/pushService.js`) that takes a tenant
  connection + target user id(s), looks up their tokens, and sends. Call it from
  the existing event points (approval workflow service, chat service, reminder
  schedulers) — all of which already have a tenant connection in scope.

---

## 2. Data model — `src/db/schemas/platform/pushTokenSchema.js`

```js
import mongoose from 'mongoose';

const pushTokenSchema = new mongoose.Schema({
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  token:      { type: String, required: true, unique: true }, // "ExponentPushToken[…]"
  platform:   { type: String, enum: ['ios', 'android', 'web'], default: 'android' },
  device_id:  { type: String, default: null },   // optional Constants.deviceName / installationId
  app_version:{ type: String, default: null },
  last_seen_at:{ type: Date, default: Date.now },
}, { timestamps: true });

// One row per (user, token). Re-registering the same token just updates it.
pushTokenSchema.index({ user_id: 1, token: 1 }, { unique: true });

export default pushTokenSchema;
```

Repository `src/repositories/pushTokenRepository.js` (per-request, mirror the
existing repo pattern — `constructor(tenantDb) { this.model = tenantDb.model('PushToken', pushTokenSchema); }`), with:
- `upsert({ user_id, token, platform, device_id, app_version })` → update-or-insert on `token`, refresh `last_seen_at`.
- `listForUsers(userIds)` → all tokens for a set of users.
- `removeByToken(token)` / `removeManyByTokens(tokens[])` → prune dead tokens.
- `removeForUserDevice(user_id, token)` → logout / unregister.

---

## 3. API endpoints — `routes/platform/pushTokenRoutes.js`

Mounted `app.use('/api/v1/platform/push-tokens', pushTokenRoutes)` with
`router.use(authAndResolveTenant)`. No feature-flag gate (push is cross-cutting).

| Method | Path | Body | Purpose |
|---|---|---|---|
| `POST` | `/platform/push-tokens` | `{ token, platform?, device_id?, app_version? }` | Register/refresh the caller's token. `user_id = req.user.userId`. Validate `token` starts with `ExponentPushToken[` or `ExpoPushToken[`. Upsert. → `201 { success:true }` |
| `DELETE` | `/platform/push-tokens` | `{ token }` | Unregister (on logout / permission revoked). Delete the row. → `200 { success:true }` |

Validation (express-validator): `body('token').isString().notEmpty().matches(/^Expo(nent)?PushToken\[/)`, `body('platform').optional().isIn(['ios','android','web'])`.

Controller is thin: `new PushTokenRepository(req.tenantDb)` → upsert/remove with
`req.user.userId`.

---

## 4. Push sender — `src/services/pushService.js`

Use the official **`expo-server-sdk`** (handles chunking to 100/req, validation,
receipts). `npm i expo-server-sdk` in `charitycompliance-backend`.

```js
import { Expo } from 'expo-server-sdk';
import PushTokenRepository from '../repositories/pushTokenRepository.js';

const expo = new Expo(
  process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : {}
);

/**
 * Send one notification to a set of users within a tenant.
 * @param tenantDb  the tenant mongoose connection (req.tenantDb or scheduler conn)
 * @param userIds   array of user ObjectIds/strings to notify
 * @param payload   { title, body, data }  — data drives the app deep-link (see §6)
 */
export async function sendToUsers(tenantDb, userIds, { title, body, data = {} }) {
  if (!userIds?.length) return;
  const repo = new PushTokenRepository(tenantDb);
  const rows = await repo.listForUsers(userIds);
  const tokens = [...new Set(rows.map(r => r.token))].filter(Expo.isExpoPushToken);
  if (!tokens.length) return;

  const messages = tokens.map(to => ({
    to,
    sound: 'default',
    title,
    body,
    data,                       // { type, id, screen, params } — see §6
    channelId: 'default',       // matches the Android channel the app creates
    priority: 'high',
  }));

  const tickets = [];
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      const res = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...res.map((t, i) => ({ ...t, token: chunk[i].to })));
    } catch (err) {
      // log and continue — never let a push failure break the triggering request
    }
  }

  // Immediate ticket errors: prune tokens Expo already knows are dead.
  const dead = tickets
    .filter(t => t.status === 'error' && t.details?.error === 'DeviceNotRegistered')
    .map(t => t.token);
  if (dead.length) await repo.removeManyByTokens(dead);

  // Store receiptIds for the async receipt sweep (§4a) if you want full cleanup.
  return tickets.filter(t => t.status === 'ok').map(t => t.id);
}
```

**§4a — Receipts (recommended, optional first pass):** ~15 min after sending,
`expo.getPushNotificationReceiptsAsync(receiptIds)`; any receipt with
`details.error === 'DeviceNotRegistered'` → delete that token. Run as a small
scheduled sweep (see the existing `*ReminderService` pattern) or skip in v1 and
rely on the immediate-ticket pruning above.

**Golden rule:** push sending must be **fire-and-forget / best-effort** — wrap in
try/catch and never block or fail the event that triggered it.

---

## 5. Where to trigger it (event integration points)

Call `sendToUsers(tenantDb, targetUserIds, payload)` at these points. All of
these already run inside a tenant context.

| Event | Where | Target users | Title / body |
|---|---|---|---|
| Approval routed to an approver (new pending step) | `approvalWorkflowService` after step activation | the current step's approver(s) | "Approval needs your review" / `<request type/title>` |
| Approval decided (approved/declined) | approve/reject handlers | `submitted_by` | "Your request was approved/declined" |
| Escalation / opinion requested | `escalateForOpinion` | `escalated_to` | "A colleague asked for your opinion" |
| Rejection forwarded for review | `forwardRejectionForReview` | `forwarded_to` | "A decline needs your review" |
| COI raised on a workflow | `submitCoiRequest` | admins / COI approvers | "A conflict of interest was flagged" |
| New chat message | chat service `emitNewMessage` (already emits socket) | channel members except sender & the actively-viewing device | "<sender> in <channel>" / message preview |
| Meeting created / you're invited | meeting create | attendees | "New meeting: <title>" |
| Meeting reminder (T-24h / T-1h) | a `meetingReminderService` sweep | attendees who haven't declined | "Meeting soon: <title>" |
| Registration/fiscal/suitability reminders | existing `*ReminderService` schedulers | the responsible user(s) | reuse the reminder copy |

For **schedulers** (background jobs iterate tenants): open the tenant connection
you already use for the sweep, compute the due items, and call `sendToUsers` with
that same connection.

Respect the chat suppression the app already does (self-sent + actively-viewed
channel) — for chat, don't notify the sender; the app also dedupes locally.

---

## 6. Deep-link data contract (backend ↔ app)

Every notification's `data` object tells the app where to navigate on tap. Keep
it stable:

```json
{ "type": "approval", "id": "<mongoId>", "screen": "ApprovalDetail", "params": { "id": "<mongoId>" } }
```

Suggested `type` → `screen` map (screens already exist in the app):
- `approval` → `ApprovalDetail` `{ id }`
- `chat` → `ChatThread` `{ channelId }`
- `meeting` → `MeetingDetail` `{ id }`
- `complaint` → `ComplaintDetail` `{ id }`
- `risk` → `RiskDetail` `{ id }`
- `coi` → `CoiDetail` `{ id }`
- `policy` → `PolicyDetail` `{ id }`

App side (mobile) adds a `Notifications.addNotificationResponseReceivedListener`
that reads `response.notification.request.content.data` and calls
`navigation.navigate(screen, params)`. (Mobile task — coordinate; the screens are
all already built.)

---

## 7. Env / deps / security

- `npm i expo-server-sdk` (backend).
- **`EXPO_ACCESS_TOKEN`** (optional but recommended for prod): create in the Expo
  dashboard → Account → Access tokens; set in backend env. Enables enhanced push
  security + higher rate limits. Without it, sending still works (unauthenticated
  push is allowed) but is rate-limited and spoofable.
- No FCM/APNs secrets in the backend (they live in the Expo project credentials).
- Tokens are not PII-sensitive but scope reads to the owning user/tenant anyway.
- Rate/back-pressure: Expo accepts ~100 messages/request; the SDK chunks. For big
  fan-outs (org-wide), send async (don't await in the request path) — e.g. queue
  or `setImmediate`.

---

## 8. App-side contract (already partly done in `st-mobile`)

For the backend dev's awareness — the mobile app must:
1. On login/app-start (authenticated), call `registerForPushTokenAsync()`
   (already added in `st-mobile/src/lib/notifications.js`) → `POST /platform/push-tokens { token, platform }`.
2. On logout / 401, `DELETE /platform/push-tokens { token }`.
3. Add the tap handler (§6) to deep-link.
4. Android channel `default` already created in `setupNotifications()` — match
   `channelId: 'default'` in the payloads.

Tokens are only obtainable from a **standalone build with FCM configured** (not
Expo Go).

---

## 9. Test plan

1. Install the FCM-enabled APK; grant permission; confirm a row lands in
   `push_tokens` after login (POST endpoint).
2. Unit-test `sendToUsers` with a fake token → assert Expo call shape.
3. Manual: trigger an approval routed to a test user → notification arrives with
   the app **closed** → tap → lands on `ApprovalDetail`.
4. Kill a token (uninstall app) → next send returns `DeviceNotRegistered` →
   verify the row is pruned.
5. Load: fan-out to 200 users → chunked into 2 requests, no request-path blocking.

---

## 10. Build order (backend)

1. Schema + repository.
2. `POST`/`DELETE /platform/push-tokens` (+ mount in `app.js`).
3. `pushService.sendToUsers` (+ `expo-server-sdk`).
4. Wire the **approval-routed** trigger first (highest value), verify end-to-end.
5. Add chat + meeting + reminder triggers.
6. (Optional) receipt sweep for token cleanup; `EXPO_ACCESS_TOKEN` for prod.
