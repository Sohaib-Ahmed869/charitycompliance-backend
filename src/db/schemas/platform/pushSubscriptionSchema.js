/**
 * PushSubscription (tenant DB) — one row per browser/device a user has
 * opted into Web Push notifications from.
 *
 * Captured from the browser's PushManager.subscribe() result. The
 * `endpoint` is the unique push-service URL; `keys_p256dh` / `keys_auth`
 * are the encryption keys web-push needs to deliver an encrypted payload.
 *
 * Rows are pruned automatically when a push send returns 404/410 (the
 * browser has dropped the subscription) — see services/pushService.js.
 */

import mongoose from 'mongoose';

const pushSubscriptionSchema = new mongoose.Schema({
  // The Stewardex user this browser belongs to.
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },

  // Push-service endpoint URL — unique per browser/device.
  endpoint: {
    type: String,
    required: true,
    unique: true
  },

  // Encryption keys from the PushSubscription (stored flat).
  keys_p256dh: { type: String, required: true },
  keys_auth:   { type: String, required: true },

  // Diagnostic — which browser/device this is.
  user_agent: { type: String, default: '' },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'push_subscriptions'
});

export default pushSubscriptionSchema;
