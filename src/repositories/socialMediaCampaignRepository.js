import socialMediaCampaignSchema from '../db/schemas/platform/socialMediaCampaignSchema.js';

export class SocialMediaCampaignRepository {
  constructor(tenantDb) {
    this.SocialMediaCampaign =
      tenantDb.models.SocialMediaCampaign ||
      tenantDb.model('SocialMediaCampaign', socialMediaCampaignSchema);
  }

  async create(data) {
    const doc = new this.SocialMediaCampaign(data);
    return doc.save();
  }

  async update(id, updateData) {
    return this.SocialMediaCampaign.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true, runValidators: true }
    );
  }

  async findById(id) {
    return this.SocialMediaCampaign.findById(id).lean();
  }

  async findByOrg(orgId, filters = {}) {
    const query = { org_id: orgId };
    if (filters.status) query.status = filters.status;
    if (filters.platform) {
      query.$or = [
        { platform: filters.platform },
        { platforms: { $in: [filters.platform] } }
      ];
    }
    if (filters.search) {
      const regex = new RegExp(filters.search, 'i');
      const searchOr = [{ title: regex }, { objective: regex }, { post_url: regex }, { 'post_urls.url': regex }];
      if (query.$or) {
        // Combine existing $or (platform filter) with search by AND-ing them.
        query.$and = [{ $or: query.$or }, { $or: searchOr }];
        delete query.$or;
      } else {
        query.$or = searchOr;
      }
    }
    return this.SocialMediaCampaign.find(query).sort({ createdAt: -1 }).lean();
  }

  async updateStatus(id, status, extra = {}) {
    return this.SocialMediaCampaign.findByIdAndUpdate(
      id,
      { status, ...extra },
      { new: true }
    ).lean();
  }
}

