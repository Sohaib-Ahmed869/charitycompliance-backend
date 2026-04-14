import { getTenantConnection } from '../db/connectionManager.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { SocialMediaCampaignRepository } from '../repositories/socialMediaCampaignRepository.js';
import { ApprovalRequestRepository } from '../repositories/approvalRequestRepository.js';
import { ApprovalWorkflowService } from './approvalWorkflowService.js';
import { AppError } from '../middleware/errorHandler.js';
import { getFileUrl } from './s3Service.js';

const PERF_KEYS = ['performance_views', 'performance_clicks', 'performance_reach'];

function stripPerformanceFromMetadata(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const next = { ...meta };
  for (const k of PERF_KEYS) delete next[k];
  return next;
}

function normalizePostUrlEntries(postUrls, primaryPlatform) {
  const list = Array.isArray(postUrls) ? postUrls : [];
  const cleaned = list
    .filter((p) => p && p.platform && typeof p.url === 'string' && String(p.url).trim())
    .map((p) => {
      let url = String(p.url).trim();
      if (url && !url.startsWith('http')) url = `https://${url}`;
      return { platform: p.platform, url };
    });
  const primaryPostUrl =
    (cleaned.find((p) => p.platform === primaryPlatform)?.url) || cleaned[0]?.url || '';
  return { post_urls: cleaned, post_url: primaryPostUrl };
}

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

    const hasNonFlyer = platforms.some((p) => p && p !== 'flyers');
    const images = payload.images || [];
    if (hasNonFlyer && (!Array.isArray(images) || images.length === 0)) {
      throw new AppError(
        'At least one creative image is required for pre-publication approval',
        400,
        'IMAGES_REQUIRED'
      );
    }

    const metaIn = payload.metadata && typeof payload.metadata === 'object' ? { ...payload.metadata } : {};
    delete metaIn.mode;

    const campaign = await repo.create({
      org_id: orgObjectId,
      title: payload.title,
      platform: primaryPlatform,
      platforms,
      post_url: '',
      post_urls: [],
      objective: payload.objective || '',
      start_date: payload.start_date || null,
      end_date: payload.end_date || null,
      estimated_budget: Number(payload.estimated_budget || 0),
      ad_spend_estimate: Number(payload.ad_spend_estimate || 0),
      currency: payload.currency || 'AUD',
      images,
      notes: payload.notes || '',
      status: 'pending',
      registered_social_account: '',
      published_at: null,
      compliance_approval_request_id: null,
      last_audit_date: payload.last_audit_date || null,
      metadata: {
        ...stripPerformanceFromMetadata(metaIn),
        workflow_stage: 'pre_publication'
      }
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

  /**
   * After pre-publication approval: attach live URLs, registered account, start post-compliance workflow.
   */
  async publishCampaign(campaignId, payload, submittedBy) {
    const tenantDb = await this._getTenantDb();
    const orgObjectId = await this._getOrgObjectId(tenantDb);
    const repo = new SocialMediaCampaignRepository(tenantDb);
    const existing = await repo.findById(campaignId);
    if (!existing) throw new AppError('Campaign not found', 404, 'NOT_FOUND');
    if (String(existing.org_id) !== String(orgObjectId)) throw new AppError('Forbidden', 403, 'FORBIDDEN');
    if (String(existing.status).toLowerCase() !== 'approved') {
      throw new AppError('Only pre-approved campaigns can be published with a live link', 400, 'INVALID_STATUS');
    }

    const platforms =
      Array.isArray(existing.platforms) && existing.platforms.length > 0
        ? existing.platforms
        : [existing.platform || 'other'];
    const primaryPlatform = platforms[0] || 'other';

    const incoming = Array.isArray(payload.post_urls) ? payload.post_urls : [];
    const fromLegacy = payload.post_url ? [{ platform: primaryPlatform, url: payload.post_url }] : [];
    const merged = incoming.length > 0 ? incoming : fromLegacy;
    const { post_urls: postUrls, post_url: primaryPostUrl } = normalizePostUrlEntries(merged, primaryPlatform);

    if (postUrls.length === 0 || !String(primaryPostUrl || '').trim()) {
      throw new AppError('At least one live post URL is required to publish', 400, 'URL_REQUIRED');
    }
    if (platforms.length > 1) {
      const missing = platforms.filter((p) => !postUrls.some((u) => u.platform === p));
      if (missing.length > 0) {
        throw new AppError('Add a live post URL for each selected platform', 400, 'URL_REQUIRED');
      }
    }

    const registered = String(payload.registered_social_account || '').trim();
    if (!registered) {
      throw new AppError('Registered social account / handle is required', 400, 'REGISTERED_ACCOUNT_REQUIRED');
    }

    const workflowService = new ApprovalWorkflowService(this.orgId);
    const complianceRequest = await workflowService.createSocialMediaCampaignComplianceRequest(
      campaignId,
      submittedBy,
      Number(existing.ad_spend_estimate || existing.estimated_budget || 0)
    );

    const nextMeta = {
      ...(existing.metadata || {}),
      published_submitted_at: new Date().toISOString()
    };

    await repo.update(campaignId, {
      post_url: primaryPostUrl,
      post_urls: postUrls,
      registered_social_account: registered,
      published_at: new Date(),
      status: 'compliance_pending',
      compliance_approval_request_id: complianceRequest._id,
      metadata: nextMeta
    });

    const updated = await repo.findById(campaignId);
    return await this._hydrateImageUrls(updated);
  }

  /**
   * After a failed post-compliance check: resubmit verification (URLs already on record).
   */
  async resubmitPostCompliance(campaignId, submittedBy) {
    const tenantDb = await this._getTenantDb();
    const orgObjectId = await this._getOrgObjectId(tenantDb);
    const repo = new SocialMediaCampaignRepository(tenantDb);
    const arRepo = new ApprovalRequestRepository(tenantDb);
    const existing = await repo.findById(campaignId);
    if (!existing) throw new AppError('Campaign not found', 404, 'NOT_FOUND');
    if (String(existing.org_id) !== String(orgObjectId)) throw new AppError('Forbidden', 403, 'FORBIDDEN');
    const st = String(existing.status).toLowerCase();
    if (st !== 'published') {
      throw new AppError('Compliance can only be resubmitted for published campaigns', 400, 'INVALID_STATUS');
    }
    const urls =
      Array.isArray(existing.post_urls) && existing.post_urls.length > 0
        ? existing.post_urls
        : existing.post_url
          ? [{ platform: existing.platform || 'other', url: existing.post_url }]
          : [];
    if (urls.length === 0) {
      throw new AppError('Campaign has no live URLs on record', 400, 'URL_REQUIRED');
    }

    if (existing.compliance_approval_request_id) {
      const prev = await arRepo.findById(existing.compliance_approval_request_id);
      if (prev && String(prev.status).toLowerCase() === 'pending') {
        throw new AppError('A compliance review is already in progress', 400, 'COMPLIANCE_PENDING');
      }
    }

    const workflowService = new ApprovalWorkflowService(this.orgId);
    const complianceRequest = await workflowService.createSocialMediaCampaignComplianceRequest(
      campaignId,
      submittedBy,
      Number(existing.ad_spend_estimate || existing.estimated_budget || 0)
    );

    await repo.update(campaignId, {
      status: 'compliance_pending',
      compliance_approval_request_id: complianceRequest._id
    });

    const updated = await repo.findById(campaignId);
    return await this._hydrateImageUrls(updated);
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

  _validatePerformanceField(key, value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new AppError(`${key} must be a non-negative number`, 400, 'VALIDATION_ERROR');
    }
    return Math.floor(n);
  }

  async updateCampaign(campaignId, payload) {
    const tenantDb = await this._getTenantDb();
    const orgObjectId = await this._getOrgObjectId(tenantDb);
    const repo = new SocialMediaCampaignRepository(tenantDb);
    const existing = await repo.findById(campaignId);
    if (!existing) throw new AppError('Campaign not found', 404, 'NOT_FOUND');
    if (String(existing.org_id) !== String(orgObjectId)) throw new AppError('Forbidden', 403, 'FORBIDDEN');

    const st = String(existing.status || '').toLowerCase();
    if (st === 'rejected') {
      throw new AppError('Rejected campaigns cannot be updated', 400, 'INVALID_STATUS');
    }

    const contentEditable = ['draft', 'pending', 'approved'].includes(st);
    const performanceEditable = ['published', 'compliance_pending', 'compliance_verified', 'lodged'].includes(st);

    if (performanceEditable) {
      const keys = Object.keys(payload || {});
      const metadataOrAuditOnly = keys.length > 0 && keys.every((k) => k === 'metadata' || k === 'last_audit_date');
      if (!metadataOrAuditOnly) {
        throw new AppError('Only performance metrics and last audit date can be updated for published campaigns', 400, 'INVALID_STATUS');
      }
      const mergedMetadata = { ...(existing.metadata || {}) };
      for (const k of PERF_KEYS) {
        if (payload.metadata && payload.metadata[k] !== undefined) {
          mergedMetadata[k] = this._validatePerformanceField(k, payload.metadata[k]);
        }
      }
      const lockedUpdates = { metadata: mergedMetadata };
      if (payload.last_audit_date !== undefined) {
        lockedUpdates.last_audit_date = payload.last_audit_date ? new Date(payload.last_audit_date) : null;
      }
      await repo.update(campaignId, lockedUpdates);
      const updatedLocked = await repo.findById(campaignId);
      return await this._hydrateImageUrls(updatedLocked);
    }

    if (!contentEditable) {
      throw new AppError('Campaign cannot be edited in its current status', 400, 'INVALID_STATUS');
    }

    const allowed = [
      'title',
      'platform',
      'platforms',
      'post_url',
      'post_urls',
      'objective',
      'start_date',
      'end_date',
      'estimated_budget',
      'ad_spend_estimate',
      'currency',
      'images',
      'notes',
      'last_audit_date',
      'metadata'
    ];
    const updates = {};
    for (const k of allowed) {
      if (payload[k] !== undefined) updates[k] = payload[k];
    }

    if (['pending', 'approved'].includes(st)) {
      delete updates.post_url;
      delete updates.post_urls;
    }

    if (updates.platforms !== undefined) {
      const p = Array.isArray(updates.platforms) ? updates.platforms.filter(Boolean) : [];
      updates.platforms = p;
      if (!updates.platform && p.length > 0) updates.platform = p[0];
    }
    if (updates.post_urls !== undefined && st === 'draft') {
      const list = Array.isArray(updates.post_urls) ? updates.post_urls : [];
      updates.post_urls = list
        .filter((x) => x && x.platform && typeof x.url === 'string')
        .map((x) => ({ platform: x.platform, url: x.url }));
      if (!updates.post_url) {
        const prim = updates.platform || existing.platform || (Array.isArray(existing.platforms) ? existing.platforms[0] : null);
        if (prim) {
          const match = updates.post_urls.find((p) => p.platform === prim)?.url;
          if (match) updates.post_url = match;
        }
      }
    }
    if (updates.estimated_budget != null) updates.estimated_budget = Number(updates.estimated_budget || 0);
    if (updates.ad_spend_estimate != null) updates.ad_spend_estimate = Number(updates.ad_spend_estimate || 0);
    if (updates.last_audit_date !== undefined) {
      updates.last_audit_date = updates.last_audit_date ? new Date(updates.last_audit_date) : null;
    }
    if (updates.metadata !== undefined) {
      updates.metadata = stripPerformanceFromMetadata({
        ...(existing.metadata || {}),
        ...(updates.metadata || {})
      });
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
