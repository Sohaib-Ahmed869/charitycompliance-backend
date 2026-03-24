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

    const incomingPlatforms = Array.isArray(payload.platforms) ? payload.platforms.filter(Boolean) : [];
    const platforms = incomingPlatforms.length > 0 ? incomingPlatforms : (payload.platform ? [payload.platform] : []);
    const primaryPlatform = platforms[0] || payload.platform || 'other';

    const incomingPostUrls = Array.isArray(payload.post_urls) ? payload.post_urls : [];
    const postUrls = incomingPostUrls
      .filter((p) => p && p.platform && typeof p.url === 'string')
      .map((p) => ({ platform: p.platform, url: p.url }));
    const primaryPostUrl = (postUrls.find((p) => p.platform === primaryPlatform)?.url) || payload.post_url || '';

    const campaign = await repo.create({
      org_id: orgObjectId,
      title: payload.title,
      platform: primaryPlatform,
      platforms,
      post_url: primaryPostUrl || '',
      post_urls: postUrls,
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
    const currentStatus = String(existing.status || '').toLowerCase();
    const isEditableDraft = ['draft', 'pending'].includes(currentStatus);

    // Allow post-approval performance tracking updates (views) via metadata.
    if (!isEditableDraft) {
      const keys = Object.keys(payload || {});
      const metadataOnly = keys.length > 0 && keys.every((k) => k === 'metadata');
      if (!metadataOnly) {
        throw new AppError('Only performance metadata can be updated after approval', 400, 'INVALID_STATUS');
      }

      const mergedMetadata = { ...(existing.metadata || {}), ...(payload.metadata || {}) };
      if (mergedMetadata.performance_views != null) {
        const n = Number(mergedMetadata.performance_views);
        if (!Number.isFinite(n) || n < 0) {
          throw new AppError('performance_views must be a non-negative number', 400, 'VALIDATION_ERROR');
        }
        mergedMetadata.performance_views = Math.floor(n);
      }

      await repo.update(campaignId, { metadata: mergedMetadata });
      const updatedLocked = await repo.findById(campaignId);
      return await this._hydrateImageUrls(updatedLocked);
    }

    const allowed = ['title', 'platform', 'platforms', 'post_url', 'post_urls', 'objective', 'start_date', 'end_date', 'estimated_budget', 'ad_spend_estimate', 'currency', 'images', 'notes', 'metadata'];
    const updates = {};
    for (const k of allowed) {
      if (payload[k] !== undefined) updates[k] = payload[k];
    }
    if (updates.platforms !== undefined) {
      const p = Array.isArray(updates.platforms) ? updates.platforms.filter(Boolean) : [];
      updates.platforms = p;
      if (!updates.platform && p.length > 0) updates.platform = p[0];
    }
    if (updates.post_urls !== undefined) {
      const list = Array.isArray(updates.post_urls) ? updates.post_urls : [];
      updates.post_urls = list
        .filter((x) => x && x.platform && typeof x.url === 'string')
        .map((x) => ({ platform: x.platform, url: x.url }));
      if (!updates.post_url) {
        const prim = (updates.platform || existing.platform || (Array.isArray(existing.platforms) ? existing.platforms[0] : null));
        if (prim) {
          const match = updates.post_urls.find((p) => p.platform === prim)?.url;
          if (match) updates.post_url = match;
        }
      }
    }
    if (updates.estimated_budget != null) updates.estimated_budget = Number(updates.estimated_budget || 0);
    if (updates.ad_spend_estimate != null) updates.ad_spend_estimate = Number(updates.ad_spend_estimate || 0);
    if (updates.metadata !== undefined) {
      const mergedMetadata = { ...(existing.metadata || {}), ...(updates.metadata || {}) };
      if (mergedMetadata.performance_views != null) {
        const n = Number(mergedMetadata.performance_views);
        if (!Number.isFinite(n) || n < 0) {
          throw new AppError('performance_views must be a non-negative number', 400, 'VALIDATION_ERROR');
        }
        mergedMetadata.performance_views = Math.floor(n);
      }
      updates.metadata = mergedMetadata;
    }

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

