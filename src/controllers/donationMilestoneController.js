import { asyncHandler } from '../middleware/errorHandler.js';
import { DonationMilestoneService } from '../services/donationMilestoneService.js';

export const createDonationMilestone = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;
  const service = new DonationMilestoneService(orgId);

  const milestone = await service.createMilestone(req.body, userId);

  res.status(201).json({
    success: true,
    data: milestone
  });
});

export const listDonationMilestones = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new DonationMilestoneService(orgId);

  const { status, search, funding_agreement_id } = req.query;
  const milestones = await service.listMilestones({
    status,
    search,
    funding_agreement_id
  });

  res.json({
    success: true,
    data: milestones
  });
});

