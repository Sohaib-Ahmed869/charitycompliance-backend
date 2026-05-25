/**
 * pushService — Web Push (browser notification) delivery.
 *
 * Sends an encrypted notification payload to a user's subscribed
 * browsers via the standard Web Push protocol (VAPID). Works even when
 * the user's tab is closed — the browser's Service Worker receives the
 * push and shows the notification.
 *
 * Web Push is OPTIONAL: if the VAPID keys aren't configured the whole
 * module no-ops, so nothing else has to guard its calls.
 *
 * Dead subscriptions (404/410 from the push service) are pruned on the
 * spot so the push_subscriptions collection stays clean.
 */

import webpush from 'web-push';
import { webPush as webPushConfig } from '../config/index.js';
import pushSubscriptionSchema from '../db/schemas/platform/pushSubscriptionSchema.js';
import { logError, logInfo } from '../utils/logger.js';

// Configure VAPID once at module load. If keys are missing, `configured`
// stays false and every send becomes a no-op.
let configured = false;
if (webPushConfig.vapidPublicKey && webPushConfig.vapidPrivateKey) {
  try {
    webpush.setVapidDetails(
      webPushConfig.vapidSubject,
      webPushConfig.vapidPublicKey,
      webPushConfig.vapidPrivateKey
    );
    configured = true;
    logInfo('[push] Web Push configured');
  } catch (err) {
    logError('[push] VAPID configuration failed:', err?.message || err);
  }
}

/** True when VAPID keys are present — callers can skip work if not. */
export function isPushConfigured() {
  return configured;
}

/** Lazily register the PushSubscription model on a tenant connection. */
function pushModel(tenantDb) {
  return tenantDb.models.PushSubscription
    || tenantDb.model('PushSubscription', pushSubscriptionSchema);
}

/**
 * Send a Web Push notification to every browser one or more users have
 * subscribed. Best-effort and never throws — callers can fire-and-forget.
 *
 * @param {object} tenantDb  the per-tenant mongoose connection
 * @param {Array}  userIds   user _ids to notify
 * @param {object} payload   { title, body, url?, tag?, icon? } — serialised
 *                           and read by the Service Worker's push handler
 */
export async function sendPushToUsers(tenantDb, userIds, payload) {
  if (!configured || !tenantDb) return;
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (ids.length === 0) return;

  let subs;
  try {
    subs = await pushModel(tenantDb).find({ user_id: { $in: ids } }).lean();
  } catch (err) {
    logError('[push] subscription lookup failed:', err?.message || err);
    return;
  }
  if (!subs.length) return;

  const body = JSON.stringify(payload || {});
  const Model = pushModel(tenantDb);

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth } },
        body
      );
    } catch (err) {
      const status = err?.statusCode;
      // 404 / 410 — the browser dropped this subscription; prune it.
      if (status === 404 || status === 410) {
        await Model.deleteOne({ _id: sub._id }).catch(() => {});
      } else {
        logError(`[push] send failed (status=${status}):`, err?.message || err);
      }
    }
  }));
}

export default { isPushConfigured, sendPushToUsers };
