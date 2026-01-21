/**
 * Board Member Declaration Repository
 * 
 * Manages consent and declaration records for responsible persons
 */

import mongoose from 'mongoose';
import boardMemberDeclarationSchema from '../db/schemas/platform/boardMemberDeclarationSchema.js';

export class BoardMemberDeclarationRepository {
  constructor(tenantDb) {
    this.BoardMemberDeclaration = tenantDb.models.BoardMemberDeclaration || 
      tenantDb.model('BoardMemberDeclaration', boardMemberDeclarationSchema);
  }

  async findByBoardMemberId(boardMemberId) {
    return await this.BoardMemberDeclaration.findOne({ board_member_id: boardMemberId });
  }

  async findByOrgId(orgId) {
    return await this.BoardMemberDeclaration.find({ org_id: orgId });
  }

  async create(data) {
    const declaration = new this.BoardMemberDeclaration(data);
    return await declaration.save();
  }

  async update(boardMemberId, data) {
    return await this.BoardMemberDeclaration.findOneAndUpdate(
      { board_member_id: boardMemberId },
      { $set: data },
      { new: true, upsert: true }
    );
  }
}
