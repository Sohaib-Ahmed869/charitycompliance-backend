import mongoose from 'mongoose';
import trainingProgramSchema from '../db/schemas/platform/trainingProgramSchema.js';
import boardMemberSchema from '../db/schemas/platform/boardMemberSchema.js';

export class TrainingRepository {
  constructor(tenantDb) {
    this.TrainingProgram =
      tenantDb.models.TrainingProgram || tenantDb.model('TrainingProgram', trainingProgramSchema);
    this.BoardMember =
      tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
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
    const doc = new this.TrainingProgram({ ...data, modules: data.modules || [], enrollments: data.enrollments || [] });
    return await doc.save();
  }

  async updateProgram(programId, data) {
    return await this.TrainingProgram.findOneAndUpdate(
      { _id: programId },
      { $set: data },
      { new: true }
    ).lean();
  }

  async publishProgram(programId) {
    return await this.TrainingProgram.findOneAndUpdate(
      { _id: programId },
      { $set: { status: 'published', published_at: new Date() } },
      { new: true }
    ).lean();
  }

  async deleteProgram(programId) {
    return await this.TrainingProgram.findByIdAndDelete(programId);
  }

  // --- Modules ---
  async findModulesByProgram(programId) {
    const program = await this.findProgramById(programId);
    return [...(program?.modules || [])]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((m) => ({ ...m, training_program_id: programId }));
  }

  async findModuleById(moduleId) {
    const program = await this.TrainingProgram.findOne({ 'modules._id': moduleId }, { 'modules.$': 1 }).lean();
    if (!program?.modules?.[0]) return null;
    return { ...program.modules[0], training_program_id: program._id };
  }

  async createModule(data) {
    const module = {
      _id: new mongoose.Types.ObjectId(),
      title: data.title,
      description: data.description || '',
      order: data.order ?? 0,
      resources: []
    };
    await this.TrainingProgram.updateOne({ _id: data.training_program_id }, { $push: { modules: module } });
    return { ...module, training_program_id: data.training_program_id };
  }

  async updateModule(moduleId, data) {
    const setOps = {};
    Object.entries(data || {}).forEach(([k, v]) => { setOps[`modules.$.${k}`] = v; });
    await this.TrainingProgram.updateOne({ 'modules._id': moduleId }, { $set: setOps });
    return await this.findModuleById(moduleId);
  }

  async deleteModule(moduleId) {
    await this.TrainingProgram.updateOne({ 'modules._id': moduleId }, { $pull: { modules: { _id: moduleId } } });
    return { _id: moduleId };
  }

  // --- Resources ---
  async findResourcesByModule(moduleId) {
    const module = await this.findModuleById(moduleId);
    return [...(module?.resources || [])]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((r) => ({ ...r, module_id: moduleId }));
  }

  async findResourceById(resourceId) {
    const program = await this.TrainingProgram.findOne(
      { 'modules.resources._id': resourceId },
      { modules: 1 }
    ).lean();
    if (!program?.modules?.length) return null;
    for (const mod of program.modules) {
      const resource = (mod.resources || []).find((r) => String(r._id) === String(resourceId));
      if (resource) return { ...resource, module_id: mod._id };
    }
    return null;
  }

  async createResource(data) {
    const resource = {
      _id: new mongoose.Types.ObjectId(),
      name: data.name,
      type: data.type || 'pdf',
      file_url: data.file_url || null,
      link_url: data.link_url || null,
      cover_image_url: data.cover_image_url || null,
      order: data.order ?? 0,
      estimated_minutes: data.estimated_minutes ?? 0
    };
    await this.TrainingProgram.updateOne(
      { 'modules._id': data.module_id },
      { $push: { 'modules.$.resources': resource } }
    );
    return { ...resource, module_id: data.module_id };
  }

  async updateResource(resourceId, data) {
    const program = await this.TrainingProgram.findOne({ 'modules.resources._id': resourceId });
    if (!program) return null;
    let updated = null;
    program.modules.forEach((mod) => {
      (mod.resources || []).forEach((resource) => {
        if (String(resource._id) === String(resourceId)) {
          Object.entries(data || {}).forEach(([k, v]) => { resource[k] = v; });
          const plain = resource.toObject ? resource.toObject() : resource;
          updated = { ...plain, module_id: mod._id };
        }
      });
    });
    await program.save();
    return updated;
  }

  async deleteResource(resourceId) {
    const program = await this.TrainingProgram.findOne({ 'modules.resources._id': resourceId });
    if (!program) return null;
    program.modules.forEach((mod) => {
      mod.resources = (mod.resources || []).filter((r) => String(r._id) !== String(resourceId));
    });
    await program.save();
    return { _id: resourceId };
  }

  /** Get all resource IDs for a program (across all modules) */
  async getResourceIdsByProgram(programId) {
    const program = await this.findProgramById(programId);
    return (program?.modules || []).flatMap((m) => (m.resources || []).map((r) => r._id));
  }

  // --- Enrollments ---
  async findEnrollmentByProgramAndPerson(programId, boardMemberId) {
    const program = await this.findProgramById(programId);
    const match = (program?.enrollments || []).find(
      (e) => e.enrollment_type === 'internal' && String(e.board_member_id) === String(boardMemberId)
    );
    return match ? { ...match, training_program_id: programId } : null;
  }

  async findEnrollmentById(enrollmentId) {
    const program = await this.TrainingProgram.findOne({ 'enrollments._id': enrollmentId }, { enrollments: 1 }).lean();
    const match = (program?.enrollments || []).find((e) => String(e._id) === String(enrollmentId));
    return match ? { ...match, training_program_id: program?._id } : null;
  }

  async findEnrollmentsByPerson(boardMemberId) {
    const programs = await this.TrainingProgram.find(
      { 'enrollments.board_member_id': boardMemberId },
      { title: 1, category: 1, status: 1, enrollments: 1 }
    ).lean();
    const rows = [];
    programs.forEach((p) => {
      (p.enrollments || []).forEach((e) => {
        if (String(e.board_member_id) === String(boardMemberId) && e.enrollment_type === 'internal') {
          rows.push({ ...e, training_program_id: { _id: p._id, title: p.title, category: p.category, status: p.status } });
        }
      });
    });
    return rows.sort((a, b) => new Date(b.enrolled_at || 0) - new Date(a.enrolled_at || 0));
  }

  async findEnrollmentsByProgram(programId) {
    const program = await this.findProgramById(programId);
    const enrollments = (program?.enrollments || []).filter((e) => e.enrollment_type === 'internal');
    const bmIds = enrollments.map((e) => e.board_member_id).filter(Boolean);
    const members = bmIds.length ? await this.BoardMember.find({ _id: { $in: bmIds } }).lean() : [];
    const map = new Map(members.map((m) => [String(m._id), m]));
    return enrollments.map((e) => ({
      ...e,
      board_member_id: map.get(String(e.board_member_id)) || e.board_member_id
    }));
  }

  async createEnrollment(data) {
    const enrollment = { _id: new mongoose.Types.ObjectId(), ...data };
    await this.TrainingProgram.updateOne({ _id: data.training_program_id }, { $push: { enrollments: enrollment } });
    return enrollment;
  }

  async updateEnrollment(enrollmentId, data) {
    const program = await this.TrainingProgram.findOne({ 'enrollments._id': enrollmentId });
    if (!program) return null;
    const enrollment = program.enrollments.find((e) => String(e._id) === String(enrollmentId));
    Object.entries(data || {}).forEach(([k, v]) => { enrollment[k] = v; });
    await program.save();
    const plain = enrollment.toObject ? enrollment.toObject() : enrollment;
    return { ...plain, training_program_id: program._id };
  }

  async upsertEnrollment(programId, boardMemberId, defaults = {}) {
    const program = await this.findProgramById(programId);
    if (!program) return null;
    const existing = (program.enrollments || []).find(
      (e) => e.enrollment_type === 'internal' && String(e.board_member_id) === String(boardMemberId)
    );
    if (existing) return { ...existing, training_program_id: programId };
    const enrollment = {
      _id: new mongoose.Types.ObjectId(),
      enrollment_type: 'internal',
      board_member_id: boardMemberId,
      status: 'not_started',
      enrolled_at: new Date(),
      completions: [],
      ...defaults
    };
    await this.TrainingProgram.updateOne({ _id: programId }, { $push: { enrollments: enrollment } });
    return { ...enrollment, training_program_id: programId };
  }

  // --- Completions (per resource, per enrollment) ---
  async findCompletionsByEnrollment(enrollmentId) {
    const enrollment = await this.findEnrollmentById(enrollmentId);
    return (enrollment?.completions || []).map((c) => ({
      ...c,
      enrollment_id: enrollmentId
    }));
  }

  async findCompletion(enrollmentId, resourceId) {
    const enrollment = await this.findEnrollmentById(enrollmentId);
    if (!enrollment) return null;
    const match = (enrollment.completions || []).find((c) => String(c.resource_id) === String(resourceId));
    return match ? { ...match, enrollment_id: enrollmentId } : null;
  }

  async upsertCompletion(enrollmentId, resourceId, data) {
    const program = await this.TrainingProgram.findOne({ 'enrollments._id': enrollmentId });
    if (!program) return null;
    const enrollment = program.enrollments.find((e) => String(e._id) === String(enrollmentId));
    const idx = (enrollment.completions || []).findIndex((c) => String(c.resource_id) === String(resourceId));
    if (idx < 0) enrollment.completions.push({ resource_id: resourceId, status: 'not_started', ...data });
    else if (data && Object.keys(data).length) Object.assign(enrollment.completions[idx], data);
    await program.save();
    const updated = enrollment.completions.find((c) => String(c.resource_id) === String(resourceId));
    return updated ? { ...(updated.toObject ? updated.toObject() : updated), enrollment_id: enrollmentId } : null;
  }

  async setCompletionStatus(enrollmentId, resourceId, status, evidenceUrl = null) {
    const update = { status };
    if (status === 'completed') {
      update.completed_at = new Date();
      if (evidenceUrl) update.evidence_url = evidenceUrl;
    }
    return await this.upsertCompletion(enrollmentId, resourceId, update);
  }
}
