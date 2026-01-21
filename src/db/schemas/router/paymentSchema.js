/**
 * Payment Schema (Router DB)
 * 
 * Payment transaction history
 */

import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
  organization_id: {
    type: String,
    required: true,
    index: true,
    trim: true,
    lowercase: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  currency: {
    type: String,
    default: 'USD',
    uppercase: true
  },
  status: {
    type: String,
    enum: ['succeeded', 'failed', 'pending', 'refunded'],
    required: true,
    index: true
  },
  stripe_payment_id: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  stripe_payment_intent_id: {
    type: String,
    index: true,
    sparse: true
  },
  payment_date: {
    type: Date,
    required: true,
    index: true
  },
  failure_reason: {
    type: String
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  },
  created_at: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: { createdAt: 'created_at', updatedAt: false },
  collection: 'payments'
});

paymentSchema.index({ organization_id: 1 });
paymentSchema.index({ stripe_payment_id: 1 }, { unique: true, sparse: true });
paymentSchema.index({ payment_date: -1 });
paymentSchema.index({ status: 1 });

export default paymentSchema;
