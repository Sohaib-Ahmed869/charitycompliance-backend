import crypto from 'crypto';
import trainingProgramSchema from '../db/schemas/platform/trainingProgramSchema.js';

export class ExternalTrainingEnrollmentRepository {
  constructor(tenantDb) {
    this.TrainingProgram =
      tenantDb.models.TrainingProgram ||
      tenantDb.model('TrainingProgram', trainingProgramSchema);
  }

  async findByToken(token) {
    const program = await this.TrainingProgram.findOne({ 'enrollments.token': token }, { enrollments: 1 }).lean();
    const enr = (program?.enrollments || []).find((e) => e.enrollment_type === 'external' && e.token === token);
    return enr ? { ...enr, training_program_id: program._id } : null;
  }

  async findById(id) {
    const program = await this.TrainingProgram.findOne({ 'enrollments._id': id }, { enrollments: 1 }).lean();
    const enr = (program?.enrollments || []).find((e) => String(e._id) === String(id));
    return enr ? { ...enr, training_program_id: program._id } : null;
  }

  async upsertMany({ orgKey, orgObjectId, programId, invitees = [], invitedByUserId }) {
    const results = [];
    for (const inv of invitees) {
      const email = String(inv.email || '').trim().toLowerCase();
      if (!email) continue;
      const name = String(inv.name || '').trim();
      const recipientType = String(inv.recipient_type || 'visitor').trim().toLowerCase();
      const boardMemberId = inv.board_member_id ? String(inv.board_member_id) : null;
      const donorId = inv.donor_id ? String(inv.donor_id) : null;

      const token = crypto.randomBytes(24).toString('hex');
      // Do not put `metadata` in both $setOnInsert and $set — MongoDB rejects that as a path conflict.
      const metadata = {
        invited_by_user_id: invitedByUserId || null,
        recipient_type: recipientType,
        board_member_id: boardMemberId,
        donor_id: donorId
      };

      const program = await this.TrainingProgram.findById(programId);
      if (!program) continue;
      let doc = (program.enrollments || []).find(
        (e) => e.enrollment_type === 'external' && String(e.email || '').toLowerCase() === email
      );
      if (!doc) {
        doc = {
          _id: undefined,
          enrollment_type: 'external',
          org_key: orgKey,
          org_id: orgObjectId,
          email,
          name,
          token,
          status: 'not_started',
          enrolled_at: new Date(),
          progress: [],
          metadata
        };
        program.enrollments.push(doc);
      } else {
        doc.name = name;
        doc.metadata = metadata;
      }
      await program.save();
      doc = (program.enrollments || []).find((e) => e.enrollment_type === 'external' && String(e.email || '').toLowerCase() === email);
      results.push({ ...(doc?.toObject ? doc.toObject() : doc), training_program_id: program._id });
    }
    return results;
  }

  async updateProgressByToken(token, updates) {
    const setOps = {};
    Object.entries(updates || {}).forEach(([k, v]) => {
      setOps[`enrollments.$.${k}`] = v;
    });

    if (Object.keys(setOps).length === 0) {
      return this.findByToken(token);
    }

    const program = await this.TrainingProgram.findOneAndUpdate(
      {
        enrollments: {
          $elemMatch: {
            enrollment_type: 'external',
            token,
          },
        },
      },
      { $set: setOps },
      { new: true }
    )
      .select({ enrollments: 1 })
      .lean();

    if (!program) return null;
    const enr = (program.enrollments || []).find((e) => e.enrollment_type === 'external' && e.token === token);
    return enr ? { ...enr, training_program_id: program._id } : null;
  }

  async listByOrg(orgObjectId, options = {}) {
    const { search } = options;
    const programs = await this.TrainingProgram.find({ _id: { $exists: true } }, { enrollments: 1 }).lean();
    const rows = [];
    programs.forEach((p) => {
      (p.enrollments || []).forEach((e) => {
        if (e.enrollment_type !== 'external') return;
        if (String(e.org_id) !== String(orgObjectId)) return;
        rows.push({ ...e, training_program_id: p._id });
      });
    });
    if (search && String(search).trim()) {
      const s = String(search).trim().toLowerCase();
      return rows.filter((e) => String(e.email || '').toLowerCase().includes(s) || String(e.name || '').toLowerCase().includes(s));
    }
    return rows.sort((a, b) => new Date(b.updatedAt || b.enrolled_at || 0) - new Date(a.updatedAt || a.enrolled_at || 0));
  }
}

