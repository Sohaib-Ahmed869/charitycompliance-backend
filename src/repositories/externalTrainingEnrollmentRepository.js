import crypto from 'crypto';
import externalTrainingEnrollmentSchema from '../db/schemas/platform/externalTrainingEnrollmentSchema.js';

export class ExternalTrainingEnrollmentRepository {
  constructor(tenantDb) {
    this.ExternalTrainingEnrollment =
      tenantDb.models.ExternalTrainingEnrollment ||
      tenantDb.model('ExternalTrainingEnrollment', externalTrainingEnrollmentSchema);
  }

  async findByToken(token) {
    return this.ExternalTrainingEnrollment.findOne({ token }).lean();
  }

  async findById(id) {
    return this.ExternalTrainingEnrollment.findById(id).lean();
  }

  async upsertMany({ orgKey, orgObjectId, programId, invitees = [], invitedByUserId }) {
    const results = [];
    for (const inv of invitees) {
      const email = String(inv.email || '').trim().toLowerCase();
      if (!email) continue;
      const name = String(inv.name || '').trim();

      const token = crypto.randomBytes(24).toString('hex');
      const doc = await this.ExternalTrainingEnrollment.findOneAndUpdate(
        { training_program_id: programId, email },
        {
          $setOnInsert: {
            org_key: orgKey,
            org_id: orgObjectId,
            training_program_id: programId,
            email,
            token,
            status: 'not_started',
            enrolled_at: new Date(),
            progress: [],
            metadata: { invited_by_user_id: invitedByUserId || null }
          },
          $set: {
            name
          }
        },
        { upsert: true, new: true }
      ).lean();
      results.push(doc);
    }
    return results;
  }

  async updateProgressByToken(token, updates) {
    return this.ExternalTrainingEnrollment.findOneAndUpdate(
      { token },
      { $set: updates },
      { new: true }
    ).lean();
  }

  async listByOrg(orgObjectId, options = {}) {
    const { search } = options;
    const q = { org_id: orgObjectId };
    if (search && String(search).trim()) {
      const s = String(search).trim().toLowerCase();
      q.$or = [
        { email: { $regex: s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
        { name: { $regex: s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
      ];
    }
    return this.ExternalTrainingEnrollment.find(q).sort({ updatedAt: -1 }).lean();
  }
}

