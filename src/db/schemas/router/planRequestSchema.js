/**
 * PlanRequest (Router DB)
 *
 * "Talk to us" submissions from the customer-facing pricing page — used
 * primarily for the bespoke / contact-sales tier where no public price
 * is shown. Lives in the Router DB because the visitor has no tenant
 * context yet (they're a prospect, not a customer).
 *
 * On create we (a) persist the row, (b) fire a notification email to the
 * platform's SUPPORT_EMAIL inbox, and (c) send the requester a friendly
 * acknowledgement. Triage happens from the Calcite admin portal.
 *
 * Mirrors the shape of `WebsiteLead` deliberately — both are "leads",
 * but plan_request is the higher-intent flavour with an explicit plan
 * code attached so sales know what package was being looked at.
 */

import mongoose from 'mongoose';

const planRequestSchema = new mongoose.Schema({
  // ── Identity ───────────────────────────────────────────────────────
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, trim: true, lowercase: true, index: true },
  phone: { type: String, trim: true },
  organization_name: { type: String, trim: true },

  // ── What they're asking about ──────────────────────────────────────
  /**
   * Plan code the customer was looking at when they hit "Contact support"
   * (e.g. `bespoke`). Saved so triage can see which package shaped the
   * request without reading the message body.
   */
  plan_code: { type: String, trim: true, lowercase: true, index: true },
  plan_name: { type: String, trim: true },

  /** Free-text message. Optional — the form lets the user submit blank. */
  message: { type: String, trim: true, default: '' },

  /**
   * If the requester was a signed-in Stewardex tenant when they hit
   * "Contact support" (e.g. from /billing or the FeatureLockedModal),
   * we capture their orgId so Calcite triage can immediately see this
   * is an existing customer asking for an upgrade rather than a brand-
   * new prospect. Blank for anonymous /pricing submissions.
   */
  existing_org_id: { type: String, trim: true, lowercase: true, default: '', index: true },

  // ── Triage ─────────────────────────────────────────────────────────
  /**
   * Lightweight status machine. Calcite staff move requests through
   * new → contacted → closed (or directly to closed if invalid).
   */
  status: {
    type: String,
    enum: ['new', 'contacted', 'closed'],
    default: 'new',
    index: true
  },

  /** Internal triage notes appended by Calcite staff. */
  notes: { type: String, default: '' },

  /** Calcite staff user who took ownership (super_admin / support_agent). */
  assigned_to: { type: String, default: '' },

  // ── Audit trail of email delivery ──────────────────────────────────
  // We track whether the two send-on-create emails actually went out
  // so we can retry from the admin UI if either failed (transient SMTP
  // issues etc). Logged but never block the API response.
  owner_email_sent_at: { type: Date, default: null },
  ack_email_sent_at: { type: Date, default: null },
  email_send_error: { type: String, default: '' },

  // ── Provenance ─────────────────────────────────────────────────────
  source_url: { type: String, default: '' },
  source_ip: { type: String, default: '' },
  user_agent: { type: String, default: '' },

  captured_at: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true,
  collection: 'plan_requests'
});

planRequestSchema.index({ status: 1, captured_at: -1 });

export default planRequestSchema;
