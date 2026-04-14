/**
 * Funding program schema (Tenant DB)
 *
 * Charity programs under Funding: delivery focus, linked donor/funder, locations.
 */

import mongoose from 'mongoose';

const fundingProgramSchema = new mongoose.Schema({
  org_id: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true,
    default: ''
  },
  website_url: {
    type: String,
    trim: true,
    default: ''
  },
  /** Who the program serves (e.g. "Children and youth") */
  beneficiaries: {
    type: String,
    trim: true,
    default: ''
  },
  /** Linked donor / funder from the donor register */
  donor_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Donor',
    required: true,
    index: true
  },
  /** Australian states/territories (labels), e.g. "New South Wales" */
  locations: {
    type: [String],
    default: []
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
    index: true
  }
}, {
  timestamps: true,
  collection: 'funding_programs'
});

fundingProgramSchema.index({ org_id: 1, status: 1 });
fundingProgramSchema.index({ org_id: 1, donor_id: 1 });

export default fundingProgramSchema;
