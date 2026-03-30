import donorRefundSchema from '../db/schemas/platform/donorRefundSchema.js';
import donorSchema from '../db/schemas/platform/donorSchema.js';

export class DonorRefundRepository {
  constructor(tenantDb) {
    tenantDb.models.Donor || tenantDb.model('Donor', donorSchema);
    this.DonorRefund = tenantDb.models.DonorRefund || tenantDb.model('DonorRefund', donorRefundSchema);
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
