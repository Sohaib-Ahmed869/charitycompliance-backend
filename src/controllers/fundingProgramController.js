/**
 * Funding program controller
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { FundingProgramRepository } from '../repositories/fundingProgramRepository.js';
import { DonorRepository } from '../repositories/donorRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';

async function assertDonorInOrg(orgId, donorId, tenantDb) {
  const donorRepo = new DonorRepository(tenantDb);
  const donor = await donorRepo.findById(donorId);
  if (!donor || donor.org_id !== orgId) {
    throw new AppError('Donor not found', 404, 'DONOR_NOT_FOUND');
  }
  return donor;
}

async function assertApprovedDonorInOrg(orgId, donorId, tenantDb) {
  const donor = await assertDonorInOrg(orgId, donorId, tenantDb);
  if (donor.status !== 'approved') {
    throw new AppError(
      'Only approved donors can be linked to a program. Approve the donor in the Donor Register first.',
      400,
      'DONOR_NOT_APPROVED'
    );
  }
  return donor;
}

export const listFundingPrograms = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const repo = new FundingProgramRepository(tenantDb);
  const items = await repo.findAllByOrg(orgId, {
    status: req.query.status,
    search: req.query.search
  });
  res.json({ success: true, data: items });
});

export const getFundingProgramById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const repo = new FundingProgramRepository(tenantDb);
  const item = await repo.findById(req.params.programId);
  if (!item || item.org_id !== orgId) {
    throw new AppError('Program not found', 404, 'NOT_FOUND');
  }
  res.json({ success: true, data: item });
});

export const createFundingProgram = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  await assertApprovedDonorInOrg(orgId, req.body.donor_id, tenantDb);
  const repo = new FundingProgramRepository(tenantDb);
  const created = await repo.create({
    org_id: orgId,
    name: req.body.name,
    description: req.body.description ?? '',
    website_url: req.body.website_url ?? '',
    beneficiaries: req.body.beneficiaries ?? '',
    donor_id: req.body.donor_id,
    locations: Array.isArray(req.body.locations) ? req.body.locations : [],
    status: req.body.status === 'inactive' ? 'inactive' : 'active'
  });
  const populated = await repo.findById(created._id);
  res.status(201).json({ success: true, data: populated });
});

export const updateFundingProgram = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { programId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const repo = new FundingProgramRepository(tenantDb);
  const existing = await repo.findById(programId);
  if (!existing || existing.org_id !== orgId) {
    throw new AppError('Program not found', 404, 'NOT_FOUND');
  }
  if (req.body.donor_id) {
    await assertApprovedDonorInOrg(orgId, req.body.donor_id, tenantDb);
  }
  const patch = {};
  if (req.body.name != null) patch.name = req.body.name;
  if (req.body.description != null) patch.description = req.body.description;
  if (req.body.website_url != null) patch.website_url = req.body.website_url;
  if (req.body.beneficiaries != null) patch.beneficiaries = req.body.beneficiaries;
  if (req.body.donor_id != null) patch.donor_id = req.body.donor_id;
  if (req.body.locations != null) {
    patch.locations = Array.isArray(req.body.locations) ? req.body.locations : [];
  }
  if (req.body.status != null) {
    patch.status = req.body.status === 'inactive' ? 'inactive' : 'active';
  }
  const updated = await repo.update(programId, patch);
  res.json({ success: true, data: updated });
});

export const deleteFundingProgram = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { programId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const repo = new FundingProgramRepository(tenantDb);
  const existing = await repo.findById(programId);
  if (!existing || existing.org_id !== orgId) {
    throw new AppError('Program not found', 404, 'NOT_FOUND');
  }
  await repo.deleteById(programId);
  res.json({ success: true, data: { deleted: true } });
});
