/**
 * Push Token Repository
 *
 * Per-request repository (constructed with the tenant connection) that manages
 * the caller's Expo push tokens. Mirrors the existing repo pattern — the model
 * is bound to the tenant connection so writes land in the right tenant DB.
 */

import pushTokenSchema from '../db/schemas/platform/pushTokenSchema.js';

export class PushTokenRepository {
  constructor(tenantDb) {
    this.model = tenantDb.models.PushToken ||
      tenantDb.model('PushToken', pushTokenSchema);
  }

  /**
   * Register or refresh a token. Upsert keyed on the token itself (a token is
   * globally unique to a device), so re-registering just updates ownership /
   * metadata and bumps last_seen_at.
   */
  async upsert({ user_id, token, platform, device_id, app_version }) {
    const set = {
      user_id,
      token,
      last_seen_at: new Date()
    };
    if (platform) set.platform = platform;
    if (device_id !== undefined) set.device_id = device_id;
    if (app_version !== undefined) set.app_version = app_version;

    return await this.model.findOneAndUpdate(
      { token },
      { $set: set },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
  }

  /** All tokens for a set of users. */
  async listForUsers(userIds) {
    if (!userIds || userIds.length === 0) return [];
    return await this.model.find({ user_id: { $in: userIds } }).lean();
  }

  /** Remove a single token (logout / unregister). */
  async removeByToken(token) {
    return await this.model.deleteOne({ token });
  }

  /** Prune a batch of dead tokens (e.g. DeviceNotRegistered from Expo). */
  async removeManyByTokens(tokens) {
    if (!tokens || tokens.length === 0) return { deletedCount: 0 };
    return await this.model.deleteMany({ token: { $in: tokens } });
  }

  /** Remove a specific user's token (logout / permission revoked). */
  async removeForUserDevice(user_id, token) {
    return await this.model.deleteOne({ user_id, token });
  }
}

export default PushTokenRepository;
