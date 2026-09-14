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
import { Expo } from 'expo-server-sdk';
import { webPush as webPushConfig } from '../config/index.js';
import pushSubscriptionSchema from '../db/schemas/platform/pushSubscriptionSchema.js';
import PushTokenRepository from '../repositories/pushTokenRepository.js';
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

// ─────────────────────────────────────────────────────────────────────────
// Expo mobile push (Stewardex mobile app) — MOBILE_PUSH_NOTIFICATIONS_SPEC §4
//
// Separate transport from Web Push above: this delivers REMOTE push to the
// Expo (React Native) app via Expo's Push API. The backend never talks to
// FCM/APNs directly; Expo relays using the credentials in the Expo project.
// Tokens live in the tenant DB (push_tokens collection).
// ─────────────────────────────────────────────────────────────────────────

const expo = new Expo(
  process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : {}
);

/**
 * Send one notification to a set of users within a tenant via Expo push.
 *
 * Best-effort / fire-and-forget by contract: everything is wrapped so a push
 * failure NEVER blocks or breaks the event that triggered it.
 *
 * @param {object} tenantDb  the tenant mongoose connection (req.tenantDb or scheduler conn)
 * @param {Array}  userIds   user ObjectIds/strings to notify
 * @param {object} payload   { title, body, data } — data drives the app deep-link (spec §6)
 * @returns {Promise<string[]>} receipt ids for an optional async receipt sweep (may be empty)
 */
export async function sendToUsers(tenantDb, userIds, { title, body, data = {} } = {}) {
  try {
    if (!tenantDb) return [];
    const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
    if (!ids.length) return [];

    const repo = new PushTokenRepository(tenantDb);
    const rows = await repo.listForUsers(ids);
    const tokens = [...new Set(rows.map((r) => r.token))].filter((t) => Expo.isExpoPushToken(t));
    if (!tokens.length) return [];

    const messages = tokens.map((to) => ({
      to,
      sound: 'default',
      title,
      body,
      data, // { type, id, screen, params } — see spec §6
      channelId: 'default', // matches the Android channel the app creates
      priority: 'high'
    }));

    const tickets = [];
    for (const chunk of expo.chunkPushNotifications(messages)) {
      try {
        const res = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...res.map((t, i) => ({ ...t, token: chunk[i].to })));
      } catch (err) {
        // Log and continue — never let a push failure break the triggering request.
        logError('[push] Expo push chunk failed:', err?.message || err);
      }
    }

    // Immediate ticket errors: prune tokens Expo already knows are dead.
    const dead = tickets
      .filter((t) => t.status === 'error' && t.details?.error === 'DeviceNotRegistered')
      .map((t) => t.token);
    if (dead.length) {
      await repo.removeManyByTokens(dead).catch(() => {});
    }

    return tickets.filter((t) => t.status === 'ok').map((t) => t.id).filter(Boolean);
  } catch (err) {
    logError('[push] sendToUsers failed:', err?.message || err);
    return [];
  }
}

export default { isPushConfigured, sendPushToUsers, sendToUsers };
