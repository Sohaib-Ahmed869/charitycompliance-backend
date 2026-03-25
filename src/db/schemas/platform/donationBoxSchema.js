/**
 * Donation Box Schema (Tenant DB)
 * - Donation boxes are physical collection boxes with a chosen map location.
 * - Each box contains an embedded list of collection entries (tips/amount received).
 */

import mongoose from 'mongoose';

const donationBoxEntrySchema = new mongoose.Schema(
  {
    tips_count: {
      type: Number,
      min: 0,
      default: 0,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    entry_date: {
      type: Date,
      required: true,
      index: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    created_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { _id: true }
);

const donationBoxSchema = new mongoose.Schema(
  {
    org_id: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
    location: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
      address: { type: String, default: '' },
    },
    entries: {
      type: [donationBoxEntrySchema],
      default: [],
    },
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: false, collection: 'donation_boxes' }
);

donationBoxSchema.pre('save', function donationBoxPreSave(next) {
  this.updated_at = new Date();
  next();
});

// Basic indexes to keep common queries fast
donationBoxSchema.index({ org_id: 1, status: 1 });
donationBoxSchema.index({ org_id: 1, name: 'text' });
donationBoxSchema.index({ org_id: 1, 'entries.entry_date': -1 });

export default donationBoxSchema;

