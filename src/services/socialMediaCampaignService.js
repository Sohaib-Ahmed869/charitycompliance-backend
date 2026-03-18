import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { SocialMediaCampaignRepository } from '../repositories/socialMediaCampaignRepository.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { AppError } from '../middleware/errorHandler.js';
import { getFileUrl } from './s3Service.js';

export class SocialMediaCampaignService {
  constructor(orgId) {
    this.orgId = orgId;
  }

  async _getTenantDb() {
    return getTenantConnection(this.orgId);
  }

  async _getOrgObjectId(tenantDb) {
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
    return org._id;
  }

  async createCampaign(payload, submittedBy) {
    const tenantDb = await this._getTenantDb();
    const orgObjectId = await this._getOrgObjectId(tenantDb);
    const repo = new SocialMediaCampaignRepository(tenantDb);

    const campaign = await repo.create({
      org_id: orgObjectId,
      title: payload.title,
      platform: payload.platform,
      post_url: payload.post_url || '',
      objective: payload.objective || '',
      start_date: payload.start_date || null,
      end_date: payload.end_date || null,
      estimated_budget: Number(payload.estimated_budget || 0),
      ad_spend_estimate: Number(payload.ad_spend_estimate || 0),
      currency: payload.currency || 'AUD',
      images: payload.images || [],
      notes: payload.notes || '',
      status: 'pending',
      metadata: payload.metadata || {}
    });

    const workflowService = new ApprovalWorkflowService(this.orgId);
    const amountForRule = Number(payload.ad_spend_estimate || payload.estimated_budget || 0);
    const approvalRequest = await workflowService.createSocialMediaCampaignApprovalRequest(
      campaign._id.toString(),
      submittedBy,
      amountForRule
    );

    await repo.update(campaign._id, { approval_request_id: approvalRequest._id });
    const created = await repo.findById(campaign._id);
    return await this._hydrateImageUrls(created);
  }

  async listCampaigns(filters = {}) {
    const tenantDb = await this._getTenantDb();
    const orgObjectId = await this._getOrgObjectId(tenantDb);
    const repo = new SocialMediaCampaignRepository(tenantDb);
    const list = await repo.findByOrg(orgObjectId, filters);
    return await Promise.all(list.map((c) => this._hydrateImageUrls(c)));
  }

  async getById(id) {
    const tenantDb = await this._getTenantDb();
    const repo = new SocialMediaCampaignRepository(tenantDb);
    const c = await repo.findById(id);
    return await this._hydrateImageUrls(c);
  }

  async updateCampaign(campaignId, payload) {
    const tenantDb = await this._getTenantDb();
    const orgObjectId = await this._getOrgObjectId(tenantDb);
    const repo = new SocialMediaCampaignRepository(tenantDb);
    const existing = await repo.findById(campaignId);
    if (!existing) throw new AppError('Campaign not found', 404, 'NOT_FOUND');
    if (String(existing.org_id) !== String(orgObjectId)) throw new AppError('Forbidden', 403, 'FORBIDDEN');
    if (!['draft', 'pending'].includes(String(existing.status || '').toLowerCase())) {
      throw new AppError('Only draft/pending campaigns can be updated', 400, 'INVALID_STATUS');
    }

    const allowed = ['title', 'platform', 'post_url', 'objective', 'start_date', 'end_date', 'estimated_budget', 'ad_spend_estimate', 'currency', 'images', 'notes', 'metadata'];
    const updates = {};
    for (const k of allowed) {
      if (payload[k] !== undefined) updates[k] = payload[k];
    }
    if (updates.estimated_budget != null) updates.estimated_budget = Number(updates.estimated_budget || 0);
    if (updates.ad_spend_estimate != null) updates.ad_spend_estimate = Number(updates.ad_spend_estimate || 0);

    await repo.update(campaignId, updates);
    const updated = await repo.findById(campaignId);
    return await this._hydrateImageUrls(updated);
  }

  async _hydrateImageUrls(campaign) {
    if (!campaign) return campaign;
    if (!Array.isArray(campaign.images) || campaign.images.length === 0) return campaign;
    const images = await Promise.all(
      campaign.images.map(async (img) => {
        if (img?.url) return img;
        if (img?.key) {
          try {
            const url = await getFileUrl(img.key, 604800);
            return { ...img, url };
          } catch {
            return img;
          }
        }
        return img;
      })
    );
    return { ...campaign, images };
  }
}

