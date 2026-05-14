import donorRefundSchema from '../db/schemas/platform/donorRefundSchema.js';
import donorSchema from '../db/schemas/platform/donorSchema.js';

// One index-repair per tenant connection. Donor + project refunds share the
// `project_refunds` collection, so the repair is keyed on the connection and
// the promise is reused by every repository instance — see
// _repairPaymentAckTokenIndex.
const _repairPromises = new WeakMap();

export class DonorRefundRepository {
  constructor(tenantDb) {
    tenantDb.models.Donor || tenantDb.model('Donor', donorSchema);
    this.DonorRefund = tenantDb.models.DonorRefund || tenantDb.model('DonorRefund', donorRefundSchema);
    this._tenantDb = tenantDb;

    if (!_repairPromises.has(tenantDb)) {
      _repairPromises.set(tenantDb, this._repairPaymentAckTokenIndex().catch(() => {}));
    }
    this._repairPromise = _repairPromises.get(tenantDb);
  }

  /**
   * Repair the (org_key, payment_ack_token) index on the shared
   * `project_refunds` collection. Older deployments created it as a plain
   * `unique` (or `unique + sparse`) index — neither works: payment_ack_token
   * is null until the donor-acknowledgement step, org_key is constant within
   * a tenant DB, and `sparse` only skips docs missing ALL keys, so every
   * second refund collides on { org_key, null }. Drop the stale index and
   * recreate it as a PARTIAL index that only enforces uniqueness for refunds
   * that actually carry a string token. Idempotent — ProjectRefundRepository
   * runs the same repair so the two shared-collection repos converge.
   */
  async _repairPaymentAckTokenIndex() {
    const coll = this._tenantDb.collection('project_refunds');
    try {
      await coll.dropIndex('org_key_1_payment_ack_token_1');
    } catch (_) { /* not present — nothing to drop */ }
    try {
      await coll.createIndex(
        { org_key: 1, payment_ack_token: 1 },
        {
          name: 'org_key_1_payment_ack_token_1',
          unique: true,
          partialFilterExpression: { payment_ack_token: { $type: 'string' } }
        }
      );
    } catch (_) { /* already in the correct shape */ }
  }

  async findByDonorId(donorId) {
    return this.DonorRefund.find({ donor_id: donorId }).sort({ createdAt: -1 }).lean();
  }

  async findByOrgKey(orgKey, donorId = null) {
    const query = {
      org_key: orgKey,
      // Donor refunds share collection with project refunds; enforce donor shape.
      donor_id: { $exists: true, $ne: null }
    };
    if (donorId) query.donor_id = donorId;
    return this.DonorRefund.find(query)
      .populate('donor_id', 'name primary_contact.email')
      .sort({ createdAt: -1 })
      .lean();
  }

  async findById(id) {
    return this.DonorRefund.findById(id)
      .populate('donor_id', 'name primary_contact.email')
      .lean();
  }

  async findActiveByDonorId(donorId) {
    return this.DonorRefund.findOne({
      donor_id: donorId,
      status: {
        $in: [
          'pending_initiation',
          'awaiting_donor_form',
          'donor_form_submitted',
          'internal_approved',
          'refund_processing',
          'refund_payment_sent',
          'awaiting_donor_acknowledgment',
          'donor_acknowledged'
        ]
      }
    })
      .sort({ createdAt: -1 })
      .lean();
  }

  async findByToken(token, orgKey = null) {
    const query = { token };
    if (orgKey) query.org_key = orgKey;
    return this.DonorRefund.findOne(query).lean();
  }

  async findByPaymentAckToken(ackToken, orgKey) {
    if (!ackToken || !orgKey) return null;
    return this.DonorRefund.findOne({
      org_key: orgKey,
      payment_ack_token: ackToken,
      donor_id: { $exists: true, $ne: null }
    })
      .populate('donor_id', 'name primary_contact.email')
      .lean();
  }

  async create(data) {
    // Wait out the one-time index repair before the first insert — otherwise a
    // legacy non-partial index collides on { org_key, payment_ack_token: null }.
    if (this._repairPromise) await this._repairPromise;
    const doc = new this.DonorRefund(data);
    return doc.save();
  }

  async updateById(id, updateData) {
    return this.DonorRefund.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }
}
