/**
 * Push Token Schema (Tenant DB)
 *
 * Stores each user's Expo push token(s) — one row per (user, device/token).
 * The backend never talks to FCM/APNs directly; it POSTs to Expo's Push API
 * (see MOBILE_PUSH_NOTIFICATIONS_SPEC.md §2). Tokens live in the tenant DB
 * alongside the users they belong to.
 */

import mongoose from 'mongoose';

const pushTokenSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  // "ExponentPushToken[…]" / "ExpoPushToken[…]"
  token: {
    type: String,
    required: true,
    unique: true
  },
  platform: {
    type: String,
    enum: ['ios', 'android', 'web'],
    default: 'android'
  },
  // Optional Constants.deviceName / installationId
  device_id: {
    type: String,
    default: null
  },
  app_version: {
    type: String,
    default: null
  },
  last_seen_at: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// One row per (user, token). Re-registering the same token just updates it.
pushTokenSchema.index({ user_id: 1, token: 1 }, { unique: true });

export default pushTokenSchema;
