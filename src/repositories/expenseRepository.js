/**
 * Expense Repository
 * 
 * Manages expense/invoice data operations
 */

import mongoose from 'mongoose';
import expenseSchema from '../db/schemas/platform/expenseSchema.js';

export class ExpenseRepository {
  constructor(tenantDb) {
    this.Expense = tenantDb.models.Expense || 
      tenantDb.model('Expense', expenseSchema);
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
      .populate('approval_matrix_id', 'name')
      .populate('approval_request_id')
      .sort({ created_at: -1 });
  }

  async findById(id) {
    return await this.Expense.findById(id)
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      .populate('approval_request_id')
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
}
