/**
 * Asset Schema (Tenant DB)
 * 
 * IT assets and equipment tracking
 */

import mongoose from 'mongoose';

const maintenanceChecklistItemSchema = new mongoose.Schema({
  completed: { type: Boolean, default: false },
  date: { type: Date, default: null },
  person: { type: String, trim: true, default: '' },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedAt: { type: Date, default: null }
}, { _id: false });

const policyComplianceSchema = new mongoose.Schema({
  privacyPolicyUpdated: { type: Boolean, default: false },
  termsUpdated: { type: Boolean, default: false },
  accessibilityChecked: { type: Boolean, default: false },
  sslExpiry: { type: Date, default: null }
}, { _id: false });

/**
 * Bank card sub-schema. Attached to an asset of category "Banking
 * Details" so a single bank account can track multiple linked cards
 * (debit, credit, virtual, employee cards, etc.).
 *
 * PCI-DSS safety:
 *   - Full PAN (16-digit card number) is NEVER stored. Only `last4`.
 *   - CVV is NEVER stored. Field doesn't exist.
 *   - Cardholder name is encrypted at rest.
 *   - PIN is NEVER stored. Field doesn't exist.
 *
 * The expiry is stored as month + year (the only form printed on the
 * card itself). We also auto-derive a real Date in the application
 * layer for sorting and calendar emission.
 */
const bankCardSchema = new mongoose.Schema({
  // Internal label, e.g. "CEO Travel Card" or "Operations Visa". Lets
  // the org distinguish cards in lists without exposing card numbers.
  label: { type: String, required: true, trim: true },

  // Type & brand. Brand is open enum so future networks (UnionPay,
  // EFTPOS) don't require schema changes.
  card_type: {
    type: String,
    enum: ['credit', 'debit', 'prepaid', 'virtual', 'other'],
    required: true,
    default: 'debit'
  },
  brand: {
    type: String,
    enum: ['Visa', 'Mastercard', 'Amex', 'EFTPOS', 'Other'],
    default: 'Other'
  },

  // Last 4 digits of the PAN. Stored for staff to identify the card
  // ("the card ending 4421") without holding the full number. Plain
  // text — last 4 is not a PCI-sensitive value.
  last4: {
    type: String,
    trim: true,
    validate: {
      validator: (v) => !v || /^\d{4}$/.test(v),
      message: 'last4 must be exactly 4 digits if provided'
    }
  },

  // Cardholder. Encrypted via the org-wide mongooseEncryptPlugin
  // because, combined with last4 + brand, it could narrow a card down.
  cardholder_name: { type: String, trim: true, encrypted: true },

  // Issuing dates. expiry_month / expiry_year are the card-printed
  // form; expiry_date is the derived month-end Date used by indexes
  // and calendar feed. Set via the application layer at save time.
  issue_date:  { type: Date },
  expiry_month: {
    type: Number,
    min: 1, max: 12
  },
  expiry_year: {
    type: Number,
    min: 2000, max: 2099
  },
  expiry_date: { type: Date, index: true },

  // Limit (credit cards). Optional; ignored on debit/prepaid.
  credit_limit:  { type: Number, min: 0 },
  credit_limit_currency: { type: String, trim: true, default: 'AUD' },

  status: {
    type: String,
    enum: ['active', 'blocked', 'cancelled', 'expired', 'lost', 'stolen'],
    default: 'active',
    index: true
  },

  notes: { type: String, trim: true },

  // Audit stamps for the card row itself (the parent asset already
  // tracks its own updated_at; cards within can be edited
  // independently and we want to know when).
  added_by:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  added_at:   { type: Date, default: Date.now },
  updated_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  updated_at: { type: Date, default: Date.now }
}, { _id: true });

// Derive expiry_date from month + year before save, so calendar
// queries can index on a real Date. Card expiry semantics: a card
// printed "EXP 05/27" stops working at 23:59:59 on May 31 2027.
bankCardSchema.pre('save', function (next) {
  if (this.expiry_month && this.expiry_year) {
    // last day of the given month at 23:59:59 UTC
    this.expiry_date = new Date(Date.UTC(this.expiry_year, this.expiry_month, 0, 23, 59, 59));
  }
  next();
});

const assetSchema = new mongoose.Schema({
  org_id: {
    type: String,
    required: true,
    index: true
  },
  asset_name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  category: {
    type: String,
    enum: ['Computer', 'Printer', 'Network', 'Server', 'Mobile', 'Furniture', 'Software', 'Hardware', 'Subscription', 'Domain', 'Cloud Service', 'Banking Details', 'Other'],
    required: true,
    index: true
  },
  type: {
    type: String,
    required: true,
    trim: true
  },
  vendor_name: {
    type: String,
    trim: true
  },
  model: {
    type: String,
    trim: true
  },
  serial_number: {
    type: String,
    trim: true
  },
  processor: {
    type: String,
    trim: true
  },
  ram: {
    type: String,
    trim: true
  },
  storage: {
    type: String,
    trim: true
  },
  worth: {
    type: Number,
    required: true,
    min: 0
  },
  subscription_price: {
    type: Number,
    min: 0
  },
  subscription_currency: {
    type: String,
    trim: true,
    default: 'AUD'
  },
  billing_frequency: {
    type: String,
    enum: ['one_off', 'monthly', 'quarterly', 'yearly', 'ad_hoc', ''],
    default: ''
  },
  purchase_date: {
    type: Date,
    required: true
  },
  maintenance_date: {
    type: Date
  },
  maintenanceChecklist: {
    backupVerified: { type: maintenanceChecklistItemSchema, default: () => ({}) },
    softwareUpdated: { type: maintenanceChecklistItemSchema, default: () => ({}) },
    accessReviewed: { type: maintenanceChecklistItemSchema, default: () => ({}) },
    integrityChecked: { type: maintenanceChecklistItemSchema, default: () => ({}) },
    securityAudit: { type: maintenanceChecklistItemSchema, default: () => ({}) }
  },
  maintenanceStatus: {
    type: String,
    enum: ['all_good', 'attention', 'overdue'],
    default: 'attention',
    index: true
  },
  websiteUrl: {
    type: String,
    trim: true,
    default: ''
  },
  admin_name: {
    type: String,
    trim: true,
    default: ''
  },
  admin_role: {
    type: String,
    trim: true,
    default: ''
  },
  access_level: {
    type: String,
    trim: true,
    default: ''
  },
  last_login: {
    type: Date,
    default: null
  },
  policyCompliance: {
    type: policyComplianceSchema,
    default: () => ({})
  },

  // Bank cards — only meaningful when category === 'Banking Details'.
  // Stored as an embedded array so a single banking-details asset
  // (one bank account) can list all its linked cards. See PCI-DSS
  // safety notes on bankCardSchema above.
  bank_cards: {
    type: [bankCardSchema],
    default: []
  },
  department_owner: {
    type: String,
    trim: true
  },
  assigned_to: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'maintenance', 'retired'],
    default: 'active',
    index: true
  },
  documentation: {
    type: String
  },
  documentation_file_name: {
    type: String
  },
  notes: {
    type: String
  },
  // Encrypted credentials for this IT system / asset
  credentials: {
    algorithm: { type: String, default: 'aes-256-gcm' },
    iv: { type: String },
    auth_tag: { type: String },
    cipher_text: { type: String },
    // Optional metadata (e.g. last 4 chars of username) without secrets
    meta: {
      username_hint: { type: String, trim: true }
    }
  },
  created_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updated_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  collection: 'assets'
});

assetSchema.index({ org_id: 1, status: 1 });
assetSchema.index({ org_id: 1, created_at: -1 });
assetSchema.index({ org_id: 1, category: 1 });
// Fast scan for expiring cards across the org — used by the calendar
// feed and any future "Expiring cards" register page.
assetSchema.index({ org_id: 1, 'bank_cards.expiry_date': 1 });

export default assetSchema;
