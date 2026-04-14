import mongoose from 'mongoose';

const mfaTrackingSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  enrolled: { type: Boolean, default: false },
  enrolled_at: { type: Date, default: null },
  method: { type: String, default: 'totp', trim: true }
}, { _id: false });

const physicalLocationSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
  org_id: { type: String, default: '', trim: true },
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', default: null },
  name: { type: String, default: '', trim: true },
  type: { type: String, enum: ['on-site', 'off-site', 'archive'], default: 'on-site' },
  address: { type: String, default: '', trim: true },
  recordCategories: { type: [String], default: [] },
  accessLevel: { type: String, default: '', trim: true },
  access_restrictions: { type: String, default: '', trim: true },
  responsiblePerson: { type: String, default: '', trim: true },
  responsibleUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  retentionPolicy: { type: String, default: '', trim: true },
  retentionEndDate: { type: Date, default: null },
  lastAuditDate: { type: Date, default: null },
  nextAuditDue: { type: Date, default: null },
  notes: { type: String, default: '', trim: true },
  review_comment: { type: String, default: '', trim: true },
  reviewed_at: { type: Date, default: null },
  reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  documents: { type: [mongoose.Schema.Types.Mixed], default: [] },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

const sweepFundsAccessSchema = new mongoose.Schema({
  _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
  portal: { type: String, enum: ['paypal', 'stripe', 'gofundme', 'other'], required: true },
  portalLabel: { type: String, default: '', trim: true },
  portalAccountIdentifier: { type: String, default: '', trim: true },
  assignedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  assignedPersonName: { type: String, default: '', trim: true },
  permissions: { type: [String], default: [] },
  notes: { type: String, default: '', trim: true },
  active: { type: Boolean, default: true },
  created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

const itRegisterSchema = new mongoose.Schema({
  org_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  mfa_tracking: { type: [mfaTrackingSchema], default: [] },
  physical_locations: { type: [physicalLocationSchema], default: [] },
  sweep_funds_access: { type: [sweepFundsAccessSchema], default: [] },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, {
  timestamps: true,
  collection: 'it_register'
});

itRegisterSchema.index({ org_id: 1 }, { unique: true });

export default itRegisterSchema;
