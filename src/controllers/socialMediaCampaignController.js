import { asyncHandler } from '../middleware/errorHandler.js';
import { SocialMediaCampaignService } from '../services/socialMediaCampaignService.js';
import mongoose from 'mongoose';

export const createSocialMediaCampaign = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;
  const service = new SocialMediaCampaignService(orgId);
  const campaign = await service.createCampaign(req.body, userId);
  res.status(201).json({ success: true, data: campaign });
});

export const listSocialMediaCampaigns = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { status, platform, search } = req.query;
  const service = new SocialMediaCampaignService(orgId);
  const campaigns = await service.listCampaigns({ status, platform, search });
  res.json({ success: true, data: campaigns });
});

export const getSocialMediaCampaignById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const id = req.params.campaignId;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID' } });
  }
  const service = new SocialMediaCampaignService(orgId);
  const campaign = await service.getById(id);
  if (!campaign) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
  }
  res.json({ success: true, data: campaign });
});

export const updateSocialMediaCampaign = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const id = req.params.campaignId;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID' } });
  }
  const service = new SocialMediaCampaignService(orgId);
  const updated = await service.updateCampaign(id, req.body);
  res.json({ success: true, data: updated });
});

