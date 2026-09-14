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

export const publishSocialMediaCampaign = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;
  const id = req.params.campaignId;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID' } });
  }
  const service = new SocialMediaCampaignService(orgId);
  const updated = await service.publishCampaign(id, req.body, userId);
  res.json({ success: true, data: updated });
});

export const resubmitSocialMediaCompliance = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;
  const id = req.params.campaignId;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID' } });
  }
  const service = new SocialMediaCampaignService(orgId);
  const updated = await service.resubmitPostCompliance(id, userId);
  res.json({ success: true, data: updated });
});

/**
 * MKT-007 — Pause or resume a campaign. Stashes the prior status in
 * `paused_from_status` so resume restores the original state instead
 * of guessing. Pausing from an already-paused state is a no-op;
 * resuming a non-paused campaign returns the row unchanged.
 */
export const pauseSocialMediaCampaign = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const id = req.params.campaignId;
  const action = req.body?.action;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID' } });
  }
  const { getTenantConnection } = await import('../db/connectionManager.js');
  const tenantDb = await getTenantConnection(orgId);
  const { default: socialMediaCampaignSchema } = await import('../db/schemas/platform/socialMediaCampaignSchema.js');
  const Campaign = tenantDb.models.SocialMediaCampaign || tenantDb.model('SocialMediaCampaign', socialMediaCampaignSchema);
  const campaign = await Campaign.findById(id);
  if (!campaign) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
  }
  if (action === 'pause') {
    if (campaign.status === 'paused' || campaign.status === 'archived') {
      return res.json({ success: true, data: campaign });
    }
    campaign.paused_from_status = campaign.status;
    campaign.status = 'paused';
  } else {
    if (campaign.status !== 'paused') {
      return res.json({ success: true, data: campaign });
    }
    campaign.status = campaign.paused_from_status || 'approved';
    campaign.paused_from_status = null;
  }
  await campaign.save();
  res.json({ success: true, data: campaign });
});

/**
 * MKT-008 — Archive a campaign. Terminal state — only restorable by
 * a SuperAdmin path (not exposed). Clears `paused_from_status` since
 * an archived campaign can't resume.
 */
export const archiveSocialMediaCampaign = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const id = req.params.campaignId;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid campaign ID' } });
  }
  const { getTenantConnection } = await import('../db/connectionManager.js');
  const tenantDb = await getTenantConnection(orgId);
  const { default: socialMediaCampaignSchema } = await import('../db/schemas/platform/socialMediaCampaignSchema.js');
  const Campaign = tenantDb.models.SocialMediaCampaign || tenantDb.model('SocialMediaCampaign', socialMediaCampaignSchema);
  const updated = await Campaign.findByIdAndUpdate(
    id,
    { $set: { status: 'archived', paused_from_status: null, archived_at: new Date() } },
    { new: true }
  );
  if (!updated) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Campaign not found' } });
  }
  res.json({ success: true, data: updated });
});

