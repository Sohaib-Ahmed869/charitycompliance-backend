/**
 * Training Repository
 *
 * Manages training programs, modules, resources, enrollments, and completions.
 * All models are registered on the tenant DB connection.
 */

import trainingProgramSchema from '../db/schemas/platform/trainingProgramSchema.js';
import trainingModuleSchema from '../db/schemas/platform/trainingModuleSchema.js';
import trainingResourceSchema from '../db/schemas/platform/trainingResourceSchema.js';
import trainingEnrollmentSchema from '../db/schemas/platform/trainingEnrollmentSchema.js';
import trainingCompletionSchema from '../db/schemas/platform/trainingCompletionSchema.js';

export class TrainingRepository {
  constructor(tenantDb) {
    this.TrainingProgram =
      tenantDb.models.TrainingProgram || tenantDb.model('TrainingProgram', trainingProgramSchema);
    this.TrainingModule =
      tenantDb.models.TrainingModule || tenantDb.model('TrainingModule', trainingModuleSchema);
    this.TrainingResource =
      tenantDb.models.TrainingResource || tenantDb.model('TrainingResource', trainingResourceSchema);
    this.TrainingEnrollment =
      tenantDb.models.TrainingEnrollment || tenantDb.model('TrainingEnrollment', trainingEnrollmentSchema);
    this.TrainingCompletion =
      tenantDb.models.TrainingCompletion || tenantDb.model('TrainingCompletion', trainingCompletionSchema);
  }

  // --- Programs ---
  async findProgramsByOrg(orgId, options = {}) {
    const { status, includeDraft = true } = options;
    const query = { org_id: orgId };
    if (status) query.status = status;
    else if (!includeDraft) query.status = 'published';
    return await this.TrainingProgram.find(query).sort({ updatedAt: -1 }).lean();
  }

  async findProgramById(programId) {
    return await this.TrainingProgram.findById(programId).lean();
  }

  async createProgram(data) {
    const doc = new this.TrainingProgram(data);
    return await doc.save();
  }

  async updateProgram(programId, data) {
    return await this.TrainingProgram.findByIdAndUpdate(programId, { $set: data }, { new: true }).lean();
  }

  async publishProgram(programId) {
    return await this.TrainingProgram.findByIdAndUpdate(
      programId,
      { $set: { status: 'published', published_at: new Date() } },
      { new: true }
    ).lean();
  }

  async deleteProgram(programId) {
    const modules = await this.TrainingModule.find({ training_program_id: programId }).select('_id').lean();
    const moduleIds = modules.map((m) => m._id);
    await this.TrainingResource.deleteMany({ module_id: { $in: moduleIds } });
    const enrollments = await this.TrainingEnrollment.find({ training_program_id: programId }).select('_id').lean();
    const enrollmentIds = enrollments.map((e) => e._id);
    await this.TrainingCompletion.deleteMany({ enrollment_id: { $in: enrollmentIds } });
    await this.TrainingEnrollment.deleteMany({ training_program_id: programId });
    await this.TrainingModule.deleteMany({ training_program_id: programId });
    return await this.TrainingProgram.findByIdAndDelete(programId);
  }

  // --- Modules ---
  async findModulesByProgram(programId) {
    return await this.TrainingModule.find({ training_program_id: programId })
      .sort({ order: 1 })
      .lean();
  }

  async findModuleById(moduleId) {
    return await this.TrainingModule.findById(moduleId).lean();
  }

  async createModule(data) {
    const doc = new this.TrainingModule(data);
    return await doc.save();
  }

  async updateModule(moduleId, data) {
    return await this.TrainingModule.findByIdAndUpdate(moduleId, { $set: data }, { new: true }).lean();
  }

  async deleteModule(moduleId) {
    await this.TrainingResource.deleteMany({ module_id: moduleId });
    return await this.TrainingModule.findByIdAndDelete(moduleId);
  }

  // --- Resources ---
  async findResourcesByModule(moduleId) {
    return await this.TrainingResource.find({ module_id: moduleId }).sort({ order: 1 }).lean();
  }

  async findResourceById(resourceId) {
    return await this.TrainingResource.findById(resourceId).lean();
  }

  async createResource(data) {
    const doc = new this.TrainingResource(data);
    return await doc.save();
  }

  async updateResource(resourceId, data) {
    return await this.TrainingResource.findByIdAndUpdate(resourceId, { $set: data }, { new: true }).lean();
  }

  async deleteResource(resourceId) {
    return await this.TrainingResource.findByIdAndDelete(resourceId);
  }

  /** Get all resource IDs for a program (across all modules) */
  async getResourceIdsByProgram(programId) {
    const modules = await this.TrainingModule.find({ training_program_id: programId }).select('_id').lean();
    const moduleIds = modules.map((m) => m._id);
    const resources = await this.TrainingResource.find({ module_id: { $in: moduleIds } })
      .select('_id')
      .lean();
    return resources.map((r) => r._id);
  }

  // --- Enrollments ---
  async findEnrollmentByProgramAndPerson(programId, boardMemberId) {
    return await this.TrainingEnrollment.findOne({
      training_program_id: programId,
      board_member_id: boardMemberId
    }).lean();
  }

  async findEnrollmentById(enrollmentId) {
    return await this.TrainingEnrollment.findById(enrollmentId).lean();
  }

  async findEnrollmentsByPerson(boardMemberId) {
    return await this.TrainingEnrollment.find({ board_member_id: boardMemberId })
      .populate('training_program_id', 'title category status')
      .sort({ enrolled_at: -1 })
      .lean();
  }

  async findEnrollmentsByProgram(programId) {
    return await this.TrainingEnrollment.find({ training_program_id: programId })
      .populate('board_member_id')
      .lean();
  }

  async createEnrollment(data) {
    const doc = new this.TrainingEnrollment(data);
    return await doc.save();
  }

  async updateEnrollment(enrollmentId, data) {
    return await this.TrainingEnrollment.findByIdAndUpdate(enrollmentId, { $set: data }, { new: true }).lean();
  }

  async upsertEnrollment(programId, boardMemberId, defaults = {}) {
    let enrollment = await this.TrainingEnrollment.findOne({
      training_program_id: programId,
      board_member_id: boardMemberId
    });
    if (!enrollment) {
      enrollment = new this.TrainingEnrollment({
        training_program_id: programId,
        board_member_id: boardMemberId,
        status: 'assigned',
        ...defaults
      });
      await enrollment.save();
    }
    return enrollment;
  }

  // --- Completions (per resource, per enrollment) ---
  async findCompletionsByEnrollment(enrollmentId) {
    return await this.TrainingCompletion.find({ enrollment_id: enrollmentId })
      .populate('resource_id')
      .lean();
  }

  async findCompletion(enrollmentId, resourceId) {
    return await this.TrainingCompletion.findOne({
      enrollment_id: enrollmentId,
      resource_id: resourceId
    }).lean();
  }

  async upsertCompletion(enrollmentId, resourceId, data) {
    let comp = await this.TrainingCompletion.findOne({
      enrollment_id: enrollmentId,
      resource_id: resourceId
    });
    if (!comp) {
      comp = new this.TrainingCompletion({
        enrollment_id: enrollmentId,
        resource_id: resourceId,
        status: 'not_started',
        ...data
      });
      await comp.save();
    } else if (data && Object.keys(data).length) {
      comp = await this.TrainingCompletion.findByIdAndUpdate(comp._id, { $set: data }, { new: true }).lean();
    }
    return comp;
  }

  async setCompletionStatus(enrollmentId, resourceId, status, evidenceUrl = null) {
    const update = { status };
    if (status === 'completed') {
      update.completed_at = new Date();
      if (evidenceUrl) update.evidence_url = evidenceUrl;
    }
    return await this.TrainingCompletion.findOneAndUpdate(
      { enrollment_id: enrollmentId, resource_id: resourceId },
      { $set: update },
      { new: true, upsert: true }
    ).lean();
  }
}
