/**
 * Expense Repository
 * 
 * Manages expense/invoice data operations
 */

import mongoose from 'mongoose';
import expenseSchema from '../db/schemas/platform/expenseSchema.js';
import projectRegisterSchema from '../db/schemas/platform/projectRegisterSchema.js';
import fundingAgreementSchema from '../db/schemas/platform/fundingAgreementSchema.js';
import approvalMatrixSchema from '../db/schemas/platform/approvalMatrixSchema.js';
import approvalRequestSchema from '../db/schemas/platform/approvalRequestSchema.js';
import { UserRepository } from './userRepository.js';

export class ExpenseRepository {
  constructor(tenantDb) {
    // Ensure related models are registered on this tenant connection so populate() works
    tenantDb.models.ProjectRegister ||
      tenantDb.model('ProjectRegister', projectRegisterSchema);
    tenantDb.models.FundingAgreement ||
      tenantDb.model('FundingAgreement', fundingAgreementSchema);
    tenantDb.models.ApprovalMatrix ||
      tenantDb.model('ApprovalMatrix', approvalMatrixSchema);
    tenantDb.models.ApprovalRequest ||
      tenantDb.model('ApprovalRequest', approvalRequestSchema);
    
    // Register User model for populate() operations
    new UserRepository(tenantDb);

    this.Expense = tenantDb.models.Expense || 
      tenantDb.model('Expense', expenseSchema);
  }

  /**
   * Aggregate project expense readiness:
   * - Project is ready when *every* expense is `status === 'paid'`
   * - Any other status (including `cancelled`) blocks handoff.
   */
  async getProjectDeliveryReadiness(projectId) {
    const objId = mongoose.Types.ObjectId.isValid(projectId)
      ? new mongoose.Types.ObjectId(projectId)
      : projectId;

    const res = await this.Expense.aggregate([
      { $match: { project_id: objId } },
      {
        $group: {
          _id: null,
          totalRelevant: { $sum: 1 },
          paidRelevant: {
            $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] }
          },
          paidAmount: {
            $sum: {
              $cond: [{ $eq: ['$status', 'paid'] }, { $ifNull: ['$amount', 0] }, 0]
            }
          }
        }
      }
    ]);

    return res[0] || { totalRelevant: 0, paidRelevant: 0, paidAmount: 0 };
  }

  async findByOrgId(orgId, filters = {}) {
    const query = { org_id: orgId };
    
    if (filters.status) {
      query.status = filters.status;
    }
    
    if (filters.submittedBy) {
      query.submitted_by = filters.submittedBy;
    }
    
    if (filters.startDate || filters.endDate) {
      query.created_at = {};
      if (filters.startDate) {
        query.created_at.$gte = new Date(filters.startDate);
      }
      if (filters.endDate) {
        query.created_at.$lte = new Date(filters.endDate);
      }
    }
    
    return await this.Expense.find(query)
      .populate('submitted_by', 'first_name last_name email')
      .populate('assigned_to', 'first_name last_name email')
      .populate('payment_processor_id', 'first_name last_name email')
      .populate('payment_reviewer_id', 'first_name last_name email')
      .populate('payments.created_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_request_id')
      .populate('project_id', 'project_name agreement_id')
      .populate('funding_agreement_id', 'agreement_title total_amount partner_name')
      .sort({ created_at: -1 });
  }

  async findById(id) {
    return await this.Expense.findById(id)
      .populate('submitted_by', 'first_name last_name email')
      .populate('assigned_to', 'first_name last_name email')
      .populate('payment_processor_id', 'first_name last_name email')
      .populate('payment_reviewer_id', 'first_name last_name email')
      .populate('payments.created_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_request_id')
      .populate('project_id', 'project_name agreement_id')
      .populate('funding_agreement_id', 'agreement_title total_amount partner_name')
      .populate('rejected_by', 'first_name last_name email');
  }

  async create(data) {
    const expense = new this.Expense(data);
    return await expense.save();
  }

  async update(id, updateData) {
    return await this.Expense.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async updateStatus(id, status, additionalData = {}) {
    const updateData = { status, ...additionalData };
    
    if (status === 'approved') {
      updateData.approved_at = new Date();
    } else if (status === 'rejected') {
      updateData.rejected_at = new Date();
    } else if (status === 'paid') {
      updateData.paid_at = new Date();
    }
    
    return await this.Expense.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async delete(id) {
    return await this.Expense.findByIdAndDelete(id);
  }

  async findByApprovalRequestId(approvalRequestId) {
    return await this.Expense.findOne({ approval_request_id: approvalRequestId })
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_request_id');
  }

  async getProjectUtilization(projectId) {
    // Calculate total amount of approved and paid expenses for a project
    const result = await this.Expense.aggregate([
      {
        $match: {
          project_id: mongoose.Types.ObjectId.isValid(projectId) ? new mongoose.Types.ObjectId(projectId) : projectId,
          status: { $in: ['approved', 'paid'] }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' }
        }
      }
    ]);

    return result.length > 0 ? result[0].total : 0;
  }
}
