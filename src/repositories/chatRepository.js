/**
 * Chat Repository
 *
 * Per-tenant chat data access. Auto-provisions org-wide channels (general,
 * announcements) plus a department channel per Department on the first
 * channel-list read for an org. DM channels are created on demand.
 */

import mongoose from 'mongoose';
import chatChannelSchema from '../db/schemas/platform/chatChannelSchema.js';
import chatChannelMembershipSchema from '../db/schemas/platform/chatChannelMembershipSchema.js';
import chatMessageSchema from '../db/schemas/platform/chatMessageSchema.js';
import departmentSchema from '../db/schemas/platform/departmentSchema.js';
import boardMemberSchema from '../db/schemas/platform/boardMemberSchema.js';
import organizationSchema from '../db/schemas/platform/organizationSchema.js';
import chatMessageStarSchema from '../db/schemas/platform/chatMessageStarSchema.js';
import chatMessageReadSchema from '../db/schemas/platform/chatMessageReadSchema.js';
import policySchema from '../db/schemas/platform/policySchema.js';
import riskSchema from '../db/schemas/platform/riskSchema.js';
import trainingProgramSchema from '../db/schemas/platform/trainingProgramSchema.js';
import meetingSchema from '../db/schemas/platform/meetingSchema.js';
import complaintSchema from '../db/schemas/platform/complaintSchema.js';
import expenseSchema from '../db/schemas/platform/expenseSchema.js';
import partnerVettingSchema from '../db/schemas/platform/partnerVettingSchema.js';
import fundingAgreementSchema from '../db/schemas/platform/fundingAgreementSchema.js';
import projectRegisterSchema from '../db/schemas/platform/projectRegisterSchema.js';
import socialMediaCampaignSchema from '../db/schemas/platform/socialMediaCampaignSchema.js';
import assetSchema from '../db/schemas/platform/assetSchema.js';
import legalDocumentSchema from '../db/schemas/platform/legalDocumentSchema.js';
import donorSchema from '../db/schemas/platform/donorSchema.js';
import { UserRepository } from './userRepository.js';
import { getFileUrl, deleteFromS3 } from '../services/s3Service.js';
import {
  emitNewMessage, emitUpdatedMessage, emitDeletedMessage,
  emitChannelListChanged, emitMention, emitMessagesRead
} from '../services/chatSocketService.js';
import { sendPushToUsers, isPushConfigured } from '../services/pushService.js';

/**
 * Modules surfaced in the #-mention picker. Each entry is a stable mention
 * target that points to the module's landing page. `moduleId` matches the
 * frontend permissions system — picker filters out modules the user can't view.
 */
export const COMPLIANCE_MODULE_TARGETS = [
  { id: 'policies',           label: 'Policies & Procedures',  href: '/policies',                          moduleId: 'policies' },
  { id: 'risks',              label: 'Risk Register',          href: '/risk-management',                   moduleId: 'risk_mgmt' },
  { id: 'trainings',          label: 'Training',               href: '/human-resources',                   moduleId: 'human_resources' },
  { id: 'meetings',           label: 'Meetings',               href: '/meetings',                          moduleId: 'dashboard' },
  { id: 'complaints',         label: 'Complaints',             href: '/complaints/dashboard',              moduleId: 'complaints' },
  { id: 'coi',                label: 'Conflict of Interest',   href: '/coi',                               moduleId: 'coi' },
  { id: 'expenses',           label: 'Financial Controls',     href: '/finances/financial-controls',       moduleId: 'financial_mgmt' },
  { id: 'sweep-funds',        label: 'Sweep Funds',            href: '/finances/sweep-funds',              moduleId: 'financial_mgmt' },
  { id: 'workflows',          label: 'Approval Workflows',     href: '/approval-workflows',                moduleId: 'approval_workflow' },
  { id: 'audit-trail',        label: 'Audit Trail',            href: '/audit-trail',                       moduleId: 'audit_trail' },
  { id: 'charity-admin',      label: 'Charity Administration', href: '/charity-administration',            moduleId: 'charity_admin' },
  { id: 'people',             label: 'Responsible People',     href: '/charity-administration/responsible-people', moduleId: 'charity_admin' },
  { id: 'donors',             label: 'Donors',                 href: '/grants-donors/donors',              moduleId: 'grants_donors' },
  { id: 'partner-vetting',    label: 'Partner Vetting',        href: '/grants-donors/partner-vetting',     moduleId: 'grants_donors' },
  { id: 'funding-agreements', label: 'Funding Agreements',     href: '/grants-donors/funding-agreements',  moduleId: 'grants_donors' },
  { id: 'projects',           label: 'Project Monitoring',     href: '/grants-donors/project-monitoring',  moduleId: 'grants_donors' },
  { id: 'donation-boxes',     label: 'Donation Boxes',         href: '/donation-boxes',                    moduleId: 'donation_boxes' },
  { id: 'social-campaigns',   label: 'Marketing Campaigns',    href: '/social-media-campaigns',            moduleId: 'social_media_campaigns' },
  { id: 'volunteers',         label: 'Volunteers',             href: '/volunteers',                        moduleId: 'human_resources' },
  { id: 'assets',             label: 'Systems Register',       href: '/assets',                            moduleId: 'asset_mgmt' },
  { id: 'bcp',                label: 'Business Continuity',    href: '/bcp',                               moduleId: 'bcp' },
  { id: 'legal-docs',         label: 'Legal Documents',        href: '/legal-documents',                   moduleId: 'legal_docs' },
  { id: 'reporting',          label: 'Reporting & Compliance', href: '/reporting',                         moduleId: 'reporting' },
  { id: 'fiscal-reports',     label: 'Fiscal Reports',         href: '/finance/fiscal-reports',            moduleId: 'reporting' },
  { id: 'bas-lodgement',      label: 'BAS Lodgement',          href: '/finance/bas-lodgement',             moduleId: 'reporting' },
  { id: 'dashboard',          label: 'Dashboard',              href: '/dashboard',                         moduleId: 'dashboard' },
  { id: 'calendar',           label: 'Calendar',               href: '/calendar',                          moduleId: 'dashboard' }
];

/**
 * Searchable entity collections. Each entry tells the search how to query a
 * collection, how to render a result, and which moduleId protects access.
 *
 * NOTE: only schemas with non-encrypted, plain-string title fields are listed.
 * Adding a schema whose title field is encrypted requires using its `<field>_hash`
 * blind index instead of a regex (encrypted fields can only be matched exactly).
 */
const COMPLIANCE_ENTITY_TARGETS = [
  { type: 'policy',           label: 'Policy',            modelName: 'Policy',              schema: policySchema,              titleField: 'title',            statusField: 'status',          moduleId: 'policies',                hrefBuilder: (id) => `/policies/${id}` },
  { type: 'risk',             label: 'Risk',              modelName: 'Risk',                schema: riskSchema,                titleField: 'title',            statusField: 'status',          moduleId: 'risk_mgmt',               hrefBuilder: (id) => `/risk-management/${id}` },
  { type: 'training',         label: 'Training',          modelName: 'TrainingProgram',     schema: trainingProgramSchema,     titleField: 'title',            statusField: 'status',          moduleId: 'human_resources',         hrefBuilder: (id) => `/human-resources/trainings/${id}` },
  { type: 'meeting',          label: 'Meeting',           modelName: 'Meeting',             schema: meetingSchema,             titleField: 'title',            statusField: 'status',          moduleId: 'dashboard',               hrefBuilder: (id) => `/meetings/${id}` },
  { type: 'complaint',        label: 'Complaint',         modelName: 'Complaint',           schema: complaintSchema,           titleField: 'complaint_title',  statusField: 'status',          moduleId: 'complaints',              hrefBuilder: (id) => `/complaints/${id}` },
  { type: 'expense',          label: 'Expense',           modelName: 'Expense',             schema: expenseSchema,             titleField: 'expense_name',     statusField: 'status',          moduleId: 'financial_mgmt',          hrefBuilder: (id) => `/expenses/${id}` },
  { type: 'partner',          label: 'Partner',           modelName: 'PartnerVetting',      schema: partnerVettingSchema,      titleField: 'name',             statusField: 'status',          moduleId: 'grants_donors',           hrefBuilder: (id) => `/grants-donors/partner-vetting/${id}` },
  { type: 'funding-agreement',label: 'Funding Agreement', modelName: 'FundingAgreement',    schema: fundingAgreementSchema,    titleField: 'agreement_title',  statusField: 'status',          moduleId: 'grants_donors',           hrefBuilder: (id) => `/grants-donors/funding-agreements/${id}` },
  { type: 'project',          label: 'Project',           modelName: 'ProjectRegister',     schema: projectRegisterSchema,     titleField: 'project_name',     statusField: 'status',          moduleId: 'grants_donors',           hrefBuilder: (id) => `/grants-donors/project-monitoring/${id}` },
  { type: 'social-campaign',  label: 'Marketing Campaign',modelName: 'SocialMediaCampaign', schema: socialMediaCampaignSchema, titleField: 'title',            statusField: 'status',          moduleId: 'social_media_campaigns',  hrefBuilder: (id) => `/social-media-campaigns/${id}` },
  { type: 'asset',            label: 'System Asset',      modelName: 'Asset',               schema: assetSchema,               titleField: 'asset_name',       statusField: 'status',          moduleId: 'asset_mgmt',              hrefBuilder: (id) => `/assets/${id}` },
  { type: 'legal-doc',        label: 'Legal Document',    modelName: 'LegalDocument',       schema: legalDocumentSchema,       titleField: 'document_name',    statusField: null,              moduleId: 'legal_docs',              hrefBuilder: () => `/legal-documents` },
  { type: 'donor',            label: 'Donor',             modelName: 'Donor',               schema: donorSchema,               titleField: 'name',             statusField: null,              moduleId: 'grants_donors',           hrefBuilder: (id) => `/grants-donors/donors/${id}` }
];

/** Module IDs that are always granted to every user (mirrors the frontend ALWAYS_GRANTED set). */
const ALWAYS_GRANTED_MODULES = new Set(['dashboard', 'support_tickets']);

/** Returns true if a permissions array grants view access for `moduleId`. */
function canViewModuleSync(permissions, moduleId) {
  if (!moduleId) return true;
  if (ALWAYS_GRANTED_MODULES.has(moduleId)) return true;
  if (!Array.isArray(permissions)) return false;
  if (permissions.includes('*:*')) return true;
  return permissions.includes(`module:${moduleId}:view`)
      || permissions.includes(`module:${moduleId}:edit`)
      || permissions.includes(`module:${moduleId}:delete`);
}

const toObjectId = (v) => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

/* ------------------------------ Caches ------------------------------ */

// Skip the expensive `ensureCoreChannels` work when the same (org, user) was
// provisioned recently in this process. New departments / users join the
// system; the TTL bounds how long they wait to be picked up.
const PROVISION_TTL_MS = 5 * 60 * 1000;
const _provisionedAt = new Map(); // key=`${orgSlug}:${userId}` → ts

// S3 signed URLs are valid for a week — re-signing them on every list call
// is wasted network and money. Cache by s3 key, refresh ~1 day before expiry.
const SIGNED_URL_TTL_MS = 6 * 24 * 60 * 60 * 1000;
const _signedUrlCache = new Map();

/**
 * `req.orgId` is the slug used to find the tenant DB (e.g. "compliance_212312"),
 * NOT a Mongo ObjectId. Tenant-DB documents store `org_id` as the Organization
 * document's _id. Resolve once per request and cache on the repo instance.
 */

export class ChatRepository {
  constructor(tenantDb, orgIdSlug = null) {
    this.tenantDb = tenantDb;
    /** Tenant slug from req.orgId — used as the socket-room key. Set via constructor or setOrgIdSlug. */
    this._orgIdSlug = orgIdSlug;
    // Side-effect: register User on this connection so .populate('sender_user_id') decrypts
    // first_name / last_name / email via the encrypt plugin's find post-hook.
    new UserRepository(tenantDb);
    tenantDb.models.Department || tenantDb.model('Department', departmentSchema);
    tenantDb.models.BoardMember || tenantDb.model('BoardMember', boardMemberSchema);
    tenantDb.models.Organization || tenantDb.model('Organization', organizationSchema);

    this.Channel = tenantDb.models.ChatChannel || tenantDb.model('ChatChannel', chatChannelSchema);
    this.Membership = tenantDb.models.ChatChannelMembership ||
      tenantDb.model('ChatChannelMembership', chatChannelMembershipSchema);
    this.Message = tenantDb.models.ChatMessage || tenantDb.model('ChatMessage', chatMessageSchema);
    this.Star = tenantDb.models.ChatMessageStar || tenantDb.model('ChatMessageStar', chatMessageStarSchema);
    this.MessageRead = tenantDb.models.ChatMessageRead || tenantDb.model('ChatMessageRead', chatMessageReadSchema);
    this.Department = tenantDb.model('Department');
    this.BoardMember = tenantDb.model('BoardMember');
    this.Organization = tenantDb.model('Organization');
    this.User = tenantDb.model('User');
  }

  /** Resolve the Organization _id (real ObjectId) from the tenant DB. */
  async _resolveOrgObjectId() {
    if (this._orgObjectId) return this._orgObjectId;
    const org = await this.Organization.findOne({}).select('_id').lean();
    if (!org) throw new Error('ORG_NOT_FOUND');
    this._orgObjectId = org._id;
    return this._orgObjectId;
  }

  // ---------- provisioning ----------

  /**
   * Idempotently ensure the standing channels exist for an org and that every
   * active user is a member of the org-wide channels. Department channels get
   * the corresponding department's BoardMember.user_id set as members.
   *
   * Cheap to run on every channel-list read — uses upsert + existence checks.
   */
  async ensureCoreChannels(orgIdSlugArg, currentUserId) {
    if (orgIdSlugArg) this._orgIdSlug = orgIdSlugArg;
    // Hot path: skip the heavy upserts when we provisioned this (org, user)
    // recently. New departments / users propagate within PROVISION_TTL_MS.
    const cacheKey = `${this._orgIdSlug || 'unknown'}:${String(currentUserId)}`;
    const last = _provisionedAt.get(cacheKey);
    if (last && (Date.now() - last) < PROVISION_TTL_MS) return;

    const org = await this._resolveOrgObjectId();

    const orgWide = [
      { kind: 'general',       name: 'general',       description: 'Organisation-wide. Admins post; everyone reads.', posting_open: false },
      { kind: 'announcements', name: 'announcements', description: 'Important notices. Admins only.',                  posting_open: false }
    ];

    for (const def of orgWide) {
      await this.Channel.updateOne(
        { org_id: org, kind: def.kind },
        { $setOnInsert: { ...def, org_id: org, created_by_user_id: toObjectId(currentUserId) } },
        { upsert: true }
      );
    }

    // Department channels — one per active Department.
    const departments = await this.Department.find({ org_id: org, is_active: true })
      .select('_id name')
      .lean();

    for (const d of departments) {
      await this.Channel.updateOne(
        { org_id: org, kind: 'department', department_id: d._id },
        {
          $setOnInsert: {
            org_id: org,
            kind: 'department',
            department_id: d._id,
            name: d.name,
            description: `Department channel for ${d.name}`,
            posting_open: true,
            created_by_user_id: toObjectId(currentUserId)
          }
        },
        { upsert: true }
      );
    }

    await this._syncMembershipsForUser(org, toObjectId(currentUserId));

    // Belt-and-braces sweeps so the channel list is never stranded:
    //   - Every active user is in general + announcements.
    //   - Every org owner / admin is in every department channel (visibility
    //     across all departments).
    await this._addAllActiveUsersToOrgWideChannels(org);
    await this._addAdminsToAllDepartmentChannels(org);

    _provisionedAt.set(cacheKey, Date.now());
  }

  async _addAllActiveUsersToOrgWideChannels(orgObjectId) {
    const orgWideChannels = await this.Channel.find({
      org_id: orgObjectId,
      kind: { $in: ['general', 'announcements'] }
    }).select('_id').lean();
    if (orgWideChannels.length === 0) return;

    const users = await this.User.find({ status: 'active' }).select('_id').lean();
    if (users.length === 0) return;

    const ops = [];
    for (const c of orgWideChannels) {
      for (const u of users) {
        ops.push({
          updateOne: {
            filter: { channel_id: c._id, user_id: u._id },
            update: { $setOnInsert: { org_id: orgObjectId, channel_id: c._id, user_id: u._id, joined_at: new Date() } },
            upsert: true
          }
        });
      }
    }
    if (ops.length) await this.Membership.bulkWrite(ops, { ordered: false });
  }

  /**
   * Org owners need visibility into every department conversation. Identified
   * by `User.is_org_owner: true` (the only admin signal stored in the tenant
   * DB — JWT `roles` are not persisted).
   */
  async _addAdminsToAllDepartmentChannels(orgObjectId) {
    const deptChannels = await this.Channel.find({
      org_id: orgObjectId,
      kind: 'department'
    }).select('_id').lean();
    if (deptChannels.length === 0) return;

    const admins = await this.User.find({ status: 'active', is_org_owner: true })
      .select('_id')
      .lean();
    if (admins.length === 0) return;

    const ops = [];
    for (const c of deptChannels) {
      for (const a of admins) {
        ops.push({
          updateOne: {
            filter: { channel_id: c._id, user_id: a._id },
            update: { $setOnInsert: { org_id: orgObjectId, channel_id: c._id, user_id: a._id, joined_at: new Date() } },
            upsert: true
          }
        });
      }
    }
    if (ops.length) await this.Membership.bulkWrite(ops, { ordered: false });
  }

  /**
   * Make sure the current user is a member of every channel they should see:
   *   - general / announcements: everyone
   *   - department: anyone whose BoardMember.user_id matches and whose
   *     BoardMember.department equals the department's name (matches existing
   *     denormalised pattern in BoardMember)
   *   - dm: only added explicitly when the DM is created
   */
  async _syncMembershipsForUser(orgObjectId, userId) {
    const org = orgObjectId instanceof mongoose.Types.ObjectId
      ? orgObjectId
      : await this._resolveOrgObjectId();
    const user = toObjectId(userId);

    const channels = await this.Channel.find({
      org_id: org,
      kind: { $in: ['general', 'announcements', 'department'] }
    }).select('_id kind department_id').lean();

    if (channels.length === 0) return;

    const departmentIds = channels.filter((c) => c.kind === 'department').map((c) => c.department_id);
    const departmentDocs = departmentIds.length
      ? await this.Department.find({ _id: { $in: departmentIds } }).select('_id name').lean()
      : [];
    const departmentNameById = new Map(departmentDocs.map((d) => [String(d._id), d.name]));

    // Department names this user belongs to (denormalised on BoardMember).
    const memberRecords = await this.BoardMember.find({
      org_id: org,
      user_id: user
    }).select('department').lean();
    const userDeptNames = new Set(
      memberRecords.map((m) => (m.department || '').trim()).filter(Boolean)
    );

    const ops = [];
    for (const c of channels) {
      let shouldBeMember = c.kind !== 'department';
      if (c.kind === 'department') {
        const dname = departmentNameById.get(String(c.department_id));
        if (dname && userDeptNames.has(dname)) shouldBeMember = true;
      }
      if (!shouldBeMember) continue;

      ops.push({
        updateOne: {
          filter: { channel_id: c._id, user_id: user },
          update: { $setOnInsert: { org_id: org, channel_id: c._id, user_id: user, joined_at: new Date() } },
          upsert: true
        }
      });
    }

    if (ops.length) await this.Membership.bulkWrite(ops, { ordered: false });
  }

  // ---------- queries ----------

  async listChannelsForUser(_orgIdSlug, userId) {
    const org = await this._resolveOrgObjectId();
    const user = toObjectId(userId);

    const memberships = await this.Membership.find({ org_id: org, user_id: user })
      .select('channel_id last_read_at notify')
      .lean();

    if (memberships.length === 0) return [];

    const byChannel = new Map(memberships.map((m) => [String(m.channel_id), m]));
    const channelIds = memberships.map((m) => m.channel_id);

    const channels = await this.Channel.find({
      _id: { $in: channelIds },
      is_archived: false
    })
      .populate('member_user_ids', 'first_name last_name email profile_picture_key')
      .lean();

    // Unread counts: messages newer than last_read_at, not authored by the user.
    const counts = await Promise.all(channels.map(async (c) => {
      const m = byChannel.get(String(c._id));
      const since = m?.last_read_at || new Date(0);
      const n = await this.Message.countDocuments({
        channel_id: c._id,
        sender_user_id: { $ne: user },
        is_deleted: false,
        createdAt: { $gt: since }
      });
      return [String(c._id), n];
    }));
    const countByChannel = new Map(counts);

    // Member counts so the frontend can render WhatsApp-style "all read" check marks.
    const memberCountAgg = await this.Membership.aggregate([
      { $match: { channel_id: { $in: channelIds } } },
      { $group: { _id: '$channel_id', count: { $sum: 1 } } }
    ]);
    const memberCountByChannel = new Map(memberCountAgg.map((r) => [String(r._id), r.count]));

    // Last message preview per channel — drives the two-line sidebar rows.
    // One aggregation that buckets by channel and grabs the newest non-deleted
    // top-level message from each.
    const lastMsgs = await this.Message.aggregate([
      {
        $match: {
          channel_id: { $in: channelIds },
          is_deleted: false,
          $or: [{ parent_message_id: null }, { parent_message_id: { $exists: false } }]
        }
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$channel_id',
          body: { $first: '$body' },
          attachments: { $first: '$attachments' },
          sender_user_id: { $first: '$sender_user_id' },
          createdAt: { $first: '$createdAt' }
        }
      }
    ]);
    const lastMsgByChannel = new Map(lastMsgs.map((m) => [String(m._id), m]));

    const enriched = channels.map((c) => {
      const lm = lastMsgByChannel.get(String(c._id)) || null;
      let preview = null;
      if (lm) {
        const hasAttachment = (lm.attachments || []).length > 0;
        const text = String(lm.body || '').replace(/\s+/g, ' ').trim();
        preview = {
          body: text || (hasAttachment ? '📎 Attachment' : ''),
          sender_user_id: lm.sender_user_id ? String(lm.sender_user_id) : null,
          createdAt: lm.createdAt
        };
      }
      return {
        ...c,
        notify: byChannel.get(String(c._id))?.notify || 'all',
        unread_count: countByChannel.get(String(c._id)) || 0,
        member_count: memberCountByChannel.get(String(c._id)) || 0,
        last_message: preview
      };
    });
    await attachMemberAvatarUrls(enriched);
    return enriched;
  }

  async getChannelForUser(_orgIdSlug, channelId, userId) {
    const org = await this._resolveOrgObjectId();
    const ch = await this.Channel.findOne({ _id: toObjectId(channelId), org_id: org }).lean();
    if (!ch) return null;
    const member = await this.Membership.findOne({
      channel_id: ch._id,
      user_id: toObjectId(userId)
    }).lean();
    if (!member) return null;
    return ch;
  }

  async listMessages(channelId, { limit = 50, beforeId = null } = {}) {
    // Thread replies (parent_message_id != null) are excluded from the main feed —
    // they only appear inside the thread panel.
    const query = {
      channel_id: toObjectId(channelId),
      is_deleted: false,
      $or: [{ parent_message_id: null }, { parent_message_id: { $exists: false } }]
    };
    if (beforeId) query._id = { $lt: toObjectId(beforeId) };
    const docs = await this._populateForResponse(
      this.Message.find(query).sort({ _id: -1 }).limit(Math.min(limit, 200))
    );
    return (docs || []).reverse();
  }

  /** Returns the parent message + all its replies in chronological order. */
  async listThread(parentMessageId) {
    const parent = await this._populateForResponse(
      this.Message.findOne({ _id: toObjectId(parentMessageId), is_deleted: false })
    );
    if (!parent) return null;
    const replies = await this._populateForResponse(
      this.Message.find({
        parent_message_id: toObjectId(parentMessageId),
        is_deleted: false
      }).sort({ _id: 1 })
    );
    return { parent, replies: replies || [] };
  }

  async createMessage({ orgId: orgIdSlugArg, channelId, senderUserId, body, replyToMessageId = null, parentMessageId = null, mentionedUserIds = [], attachments = [] }) {
    if (orgIdSlugArg) this._orgIdSlug = orgIdSlugArg;
    const orgObjectId = await this._resolveOrgObjectId();
    const channel = await this.Channel.findOne({
      _id: toObjectId(channelId),
      org_id: orgObjectId
    }).lean();
    if (!channel) throw new Error('CHANNEL_NOT_FOUND');

    const member = await this.Membership.findOne({
      channel_id: channel._id,
      user_id: toObjectId(senderUserId)
    }).lean();
    if (!member) throw new Error('NOT_A_MEMBER');

    const trimmed = String(body || '').trim();
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!trimmed && !hasAttachments) throw new Error('EMPTY_BODY');

    // Merge explicit mentioned ids with group-mention expansions (@all, @everyone, @<dept>).
    const groupExpanded = trimmed
      ? await this.expandGroupMentions({ body: trimmed, channelId: channel._id })
      : [];
    const mergedMentionIds = Array.from(new Set(
      [...(mentionedUserIds || []), ...groupExpanded].map((u) => String(u))
    )).map((s) => toObjectId(s));

    const doc = await this.Message.create({
      org_id: channel.org_id,
      channel_id: channel._id,
      sender_user_id: toObjectId(senderUserId),
      body: trimmed,
      reply_to_message_id: replyToMessageId ? toObjectId(replyToMessageId) : null,
      parent_message_id: parentMessageId ? toObjectId(parentMessageId) : null,
      mentioned_user_ids: mergedMentionIds,
      attachments: (attachments || []).map((a) => ({
        s3_key: String(a.s3_key || '').trim(),
        filename: String(a.filename || '').slice(0, 240),
        mime_type: String(a.mime_type || '').slice(0, 80),
        size_bytes: Number(a.size_bytes) || 0
      })).filter((a) => a.s3_key)
    });

    // Increment parent's cached reply count when this is a thread reply.
    if (parentMessageId) {
      await this.Message.updateOne(
        { _id: toObjectId(parentMessageId) },
        { $inc: { thread_reply_count: 1 } }
      );
    }

    await this.Channel.updateOne({ _id: channel._id }, { $set: { last_message_at: doc.createdAt } });
    // Author has implicitly read their own message.
    await this.Membership.updateOne(
      { channel_id: channel._id, user_id: toObjectId(senderUserId) },
      { $set: { last_read_at: doc.createdAt } }
    );

    const populated = await this._populateForResponse(this.Message.findById(doc._id));

    // Thread replies don't fan out to the main channel feed (they appear in the
    // thread panel), but we re-broadcast the *parent* with its bumped reply count
    // so the channel feed shows "N replies" updating live.
    if (parentMessageId) {
      const parent = await this._populateForResponse(this.Message.findById(toObjectId(parentMessageId)));
      if (parent) emitUpdatedMessage(this._orgIdSlug, channel._id, parent);
    } else {
      emitNewMessage(this._orgIdSlug, channel._id, populated);
    }
    for (const uid of (populated?.mentioned_user_ids || [])) {
      const id = uid?._id || uid;
      if (id) emitMention(this._orgIdSlug, id, { channelId: String(channel._id), messageId: String(doc._id) });
    }

    // Web Push — notify channel members of the new message. The browser
    // Service Worker suppresses the notification when the app window is
    // focused, so an active user isn't double-notified. Fire-and-forget
    // so it never delays the API response.
    this._notifyChannelMembers(channel, populated, senderUserId).catch(() => {});

    return populated;
  }

  /**
   * Send a Web Push notification to channel members for a new message.
   * Honours each member's per-channel `notify` preference. The browser
   * Service Worker decides whether to actually display it — it skips the
   * notification when a Stewardex window is focused, so an active user
   * isn't double-notified. Best-effort — wrapped so it can never disturb
   * message creation.
   */
  async _notifyChannelMembers(channel, message, senderUserId) {
    try {
      if (!isPushConfigured()) return;
      const senderId = String(senderUserId);
      const mentioned = new Set(
        (message?.mentioned_user_ids || []).map((u) => String(u?._id || u))
      );

      const memberRows = await this.Membership
        .find({ channel_id: channel._id })
        .select('user_id notify')
        .lean();

      const recipientIds = [];
      for (const row of memberRows) {
        const uid = String(row.user_id);
        if (uid === senderId) continue;                                 // the author
        if (row.notify === 'muted') continue;                           // channel muted
        if (row.notify === 'mentions' && !mentioned.has(uid)) continue;  // mentions-only
        recipientIds.push(row.user_id);
      }
      if (recipientIds.length === 0) return;

      const sender = message?.sender_user_id || {};
      const senderName = `${sender.first_name || ''} ${sender.last_name || ''}`.trim()
        || sender.email || 'Someone';
      const channelLabel = channel?.name ? `#${channel.name}` : '';
      const text = String(message?.body || '').replace(/\s+/g, ' ').trim();
      const preview = text
        ? (text.length > 140 ? `${text.slice(0, 139)}…` : text)
        : 'Sent an attachment';

      await sendPushToUsers(this.tenantDb, recipientIds, {
        title: channelLabel ? `${senderName} · ${channelLabel}` : senderName,
        body: preview,
        url: '/chat',
        tag: `chat-${String(channel._id)}`
      });
    } catch {
      /* push is best-effort — never disturb the message flow */
    }
  }

  async editMessage({ messageId, userId, body }) {
    const trimmed = String(body || '').trim();
    if (!trimmed) throw new Error('EMPTY_BODY');

    const msg = await this.Message.findById(toObjectId(messageId));
    if (!msg || msg.is_deleted) return null;
    if (String(msg.sender_user_id) !== String(userId)) throw new Error('NOT_AUTHOR');

    msg.edits.push({ body: msg.body, edited_at: new Date() });
    msg.body = trimmed;
    await msg.save();

    const populated = await this._populateForResponse(this.Message.findById(msg._id));
    emitUpdatedMessage(this._orgIdSlug, msg.channel_id, populated);
    return populated;
  }

  async softDeleteMessage({ messageId, userId, isAdmin }) {
    const msg = await this.Message.findById(toObjectId(messageId));
    if (!msg || msg.is_deleted) return null;
    if (!isAdmin && String(msg.sender_user_id) !== String(userId)) throw new Error('NOT_AUTHOR');

    msg.is_deleted = true;
    msg.deleted_at = new Date();
    await msg.save();
    emitDeletedMessage(this._orgIdSlug, msg.channel_id, msg._id);
    return msg.toObject();
  }

  async markChannelRead({ channelId, userId, at = new Date() }) {
    await this.Membership.updateOne(
      { channel_id: toObjectId(channelId), user_id: toObjectId(userId) },
      { $set: { last_read_at: at } }
    );
  }

  /**
   * Bulk-record per-message read receipts. Skips messages authored by the
   * reader (no point recording "you read your own message").
   */
  async markMessagesRead({ userId, channelId, messageIds }) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return 0;
    const orgObjectId = await this._resolveOrgObjectId();
    const userObj = toObjectId(userId);
    const ids = messageIds.map(toObjectId);

    // Drop self-authored messages so we don't seed read rows for the sender.
    const eligible = await this.Message.find({
      _id: { $in: ids },
      sender_user_id: { $ne: userObj }
    }).select('_id channel_id').lean();
    if (eligible.length === 0) return 0;

    const ops = eligible.map((m) => ({
      updateOne: {
        filter: { user_id: userObj, message_id: m._id },
        update: { $setOnInsert: {
          org_id: orgObjectId,
          user_id: userObj,
          message_id: m._id,
          channel_id: m.channel_id,
          read_at: new Date()
        } },
        upsert: true
      }
    }));
    const r = await this.MessageRead.bulkWrite(ops, { ordered: false });

    // Push the new read state to the channel so senders see "read by N" update live.
    emitMessagesRead(this._orgIdSlug, channelId, userId, eligible.map((m) => m._id));

    return r?.upsertedCount || 0;
  }

  /**
   * For a list of message ids, return a map { messageId → array of reader users }.
   * Readers come pre-populated with first/last name + email + avatar.
   */
  async getReadInfoForMessages(messageIds) {
    if (!Array.isArray(messageIds) || messageIds.length === 0) return {};
    const ids = messageIds.map(toObjectId);
    const rows = await this.MessageRead.find({ message_id: { $in: ids } })
      .populate('user_id', 'first_name last_name email profile_picture_key')
      .lean();

    const byMessage = {};
    for (const r of rows) {
      const key = String(r.message_id);
      if (!byMessage[key]) byMessage[key] = [];
      const u = r.user_id;
      if (u) {
        if (u.profile_picture_key) {
          u.profile_picture_url = await safeFileUrl(u.profile_picture_key);
        }
        byMessage[key].push({ user: u, read_at: r.read_at });
      }
    }
    return byMessage;
  }

  // ---------- reactions / pin / star ----------

  /** Toggle a reaction: if user already reacted with this emoji on this message, remove it; else add. */
  async toggleReaction({ messageId, userId, emoji }) {
    const msg = await this.Message.findById(toObjectId(messageId));
    if (!msg || msg.is_deleted) return null;
    const userObjId = toObjectId(userId);
    const cleanEmoji = String(emoji || '').trim();
    if (!cleanEmoji) throw new Error('EMPTY_EMOJI');

    const row = (msg.reactions || []).find((r) => r.emoji === cleanEmoji);
    if (row) {
      const had = row.user_ids.some((u) => String(u) === String(userObjId));
      if (had) {
        row.user_ids = row.user_ids.filter((u) => String(u) !== String(userObjId));
        if (row.user_ids.length === 0) {
          msg.reactions = msg.reactions.filter((r) => r.emoji !== cleanEmoji);
        }
      } else {
        row.user_ids.push(userObjId);
      }
    } else {
      msg.reactions.push({ emoji: cleanEmoji, user_ids: [userObjId] });
    }

    await msg.save();
    const populated = await this._populateForResponse(this.Message.findById(msg._id));
    emitUpdatedMessage(this._orgIdSlug, msg.channel_id, populated);
    return populated;
  }

  async setPin({ messageId, userId, pinned }) {
    const msg = await this.Message.findById(toObjectId(messageId));
    if (!msg || msg.is_deleted) return null;
    msg.is_pinned = !!pinned;
    msg.pinned_at = pinned ? new Date() : null;
    msg.pinned_by_user_id = pinned ? toObjectId(userId) : null;
    await msg.save();
    const populated = await this._populateForResponse(this.Message.findById(msg._id));
    emitUpdatedMessage(this._orgIdSlug, msg.channel_id, populated);
    return populated;
  }

  async listPinnedMessages(channelId) {
    const docs = await this._populateForResponse(
      this.Message.find({
        channel_id: toObjectId(channelId),
        is_pinned: true,
        is_deleted: false
      }).sort({ pinned_at: -1 })
    );
    return docs;
  }

  async setStar({ messageId, userId, starred }) {
    const msg = await this.Message.findById(toObjectId(messageId)).lean();
    if (!msg) return false;
    if (starred) {
      await this.Star.updateOne(
        { user_id: toObjectId(userId), message_id: msg._id },
        { $setOnInsert: {
            org_id: msg.org_id,
            user_id: toObjectId(userId),
            message_id: msg._id,
            channel_id: msg.channel_id
          } },
        { upsert: true }
      );
    } else {
      await this.Star.deleteOne({ user_id: toObjectId(userId), message_id: msg._id });
    }
    return true;
  }

  /**
   * Returns the user's starred messages (most recent first), populated with sender + signed avatar.
   * Stops at `limit` items so the personal list never balloons.
   */
  async listStarredMessages(userId, { limit = 100 } = {}) {
    const stars = await this.Star.find({ user_id: toObjectId(userId) })
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 200))
      .lean();
    if (stars.length === 0) return [];

    const messageIds = stars.map((s) => s.message_id);
    const messages = await this._populateForResponse(
      this.Message.find({ _id: { $in: messageIds }, is_deleted: false })
    );
    // Preserve star ordering (most recent first).
    const byId = new Map(messages.map((m) => [String(m._id), m]));
    return stars
      .map((s) => byId.get(String(s.message_id)))
      .filter(Boolean);
  }

  /**
   * Returns the set of message ids the user has starred — small, for marking
   * star state on a list of currently rendered messages.
   */
  async getStarredIds(userId, messageIds) {
    if (!messageIds || messageIds.length === 0) return new Set();
    const ids = messageIds.map((m) => toObjectId(m));
    const docs = await this.Star.find({ user_id: toObjectId(userId), message_id: { $in: ids } })
      .select('message_id')
      .lean();
    return new Set(docs.map((d) => String(d.message_id)));
  }

  // ---------- mention picker ----------

  /**
   * Returns users available as @-mention targets. When a `channelId` is
   * supplied, results are limited to members of that channel — so a private
   * or department channel only mentions its actual members.
   *
   * The plugin's find post-hook decrypts first_name/last_name/email; we then
   * resolve a signed avatar URL for the small subset that has one.
   */
  async listOrgUsersForMention({ search = '', limit = 30, channelId = null } = {}) {
    let userQuery = { status: 'active' };

    // Channel-scoped: only members of that specific channel are mentionable.
    if (channelId) {
      const memberRows = await this.Membership.find({ channel_id: toObjectId(channelId) })
        .select('user_id').lean();
      const memberIds = memberRows.map((m) => m.user_id);
      if (memberIds.length === 0) return [];
      userQuery._id = { $in: memberIds };
    }

    const users = await this.User.find(userQuery)
      .select('_id first_name last_name email profile_picture_key')
      .limit(Math.min(limit, 100))
      .lean();

    const sLower = String(search || '').trim().toLowerCase();
    const filtered = sLower
      ? users.filter((u) => {
          const full = `${u.first_name || ''} ${u.last_name || ''}`.toLowerCase();
          return full.includes(sLower) || (u.email || '').toLowerCase().includes(sLower);
        })
      : users;

    return await Promise.all(filtered.map(async (u) => ({
      _id: u._id,
      first_name: u.first_name || '',
      last_name: u.last_name || '',
      email: u.email || '',
      profile_picture_url: u.profile_picture_key
        ? await safeFileUrl(u.profile_picture_key)
        : null
    })));
  }

  // ---------- DMs ----------

  /**
   * Find an existing 1:1 DM channel between two users in this org, or create
   * one. Idempotent — calling twice with the same pair returns the same channel.
   */
  async findOrCreateDm({ requesterUserId, otherUserId }) {
    if (String(requesterUserId) === String(otherUserId)) throw new Error('SELF_DM');
    const org = await this._resolveOrgObjectId();
    const a = toObjectId(requesterUserId);
    const b = toObjectId(otherUserId);

    const existing = await this.Channel.findOne({
      org_id: org,
      kind: 'dm',
      member_user_ids: { $all: [a, b], $size: 2 }
    })
      .populate('member_user_ids', 'first_name last_name email profile_picture_key')
      .lean();
    if (existing) return await attachMemberAvatarUrls(existing);

    const created = await this.Channel.create({
      org_id: org,
      kind: 'dm',
      name: '',
      description: '',
      member_user_ids: [a, b],
      posting_open: true,
      created_by_user_id: a
    });

    await this.Membership.bulkWrite([
      { updateOne: { filter: { channel_id: created._id, user_id: a }, update: { $setOnInsert: { org_id: org, channel_id: created._id, user_id: a, joined_at: new Date() } }, upsert: true } },
      { updateOne: { filter: { channel_id: created._id, user_id: b }, update: { $setOnInsert: { org_id: org, channel_id: created._id, user_id: b, joined_at: new Date() } }, upsert: true } }
    ], { ordered: false });

    emitChannelListChanged(this._orgIdSlug);

    const out = await this.Channel.findById(created._id)
      .populate('member_user_ids', 'first_name last_name email profile_picture_key')
      .lean();
    return await attachMemberAvatarUrls(out);
  }

  // ---------- search ----------

  /**
   * Full-text-ish search across messages the requester can see (i.e. channels
   * they're a member of). Supports filters: senderId, since/until (date), hasAttachment.
   */
  async searchMessages({ requesterUserId, q = '', senderId = null, since = null, until = null, hasAttachment = null, limit = 60 }) {
    const memberRows = await this.Membership.find({ user_id: toObjectId(requesterUserId) })
      .select('channel_id').lean();
    if (memberRows.length === 0) return [];
    const channelIds = memberRows.map((m) => m.channel_id);

    const filter = { channel_id: { $in: channelIds }, is_deleted: false };
    const trimmed = String(q || '').trim();
    if (trimmed) {
      const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.body = new RegExp(escapeRe(trimmed), 'i');
    }
    if (senderId) filter.sender_user_id = toObjectId(senderId);
    if (since || until) {
      filter.createdAt = {};
      if (since) filter.createdAt.$gte = new Date(since);
      if (until) filter.createdAt.$lte = new Date(until);
    }
    if (hasAttachment === true || hasAttachment === 'true') {
      filter['attachments.0'] = { $exists: true };
    }

    const docs = await this._populateForResponse(
      this.Message.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 200))
    );
    return docs || [];
  }

  // ---------- archive / leave / mute ----------

  async setChannelArchived({ channelId, archived, requesterUserId, isAdmin }) {
    const ch = await this.Channel.findById(toObjectId(channelId));
    if (!ch) return null;
    const isCreator = ch.kind === 'private' && String(ch.created_by_user_id) === String(requesterUserId);
    if (!isAdmin && !isCreator) throw new Error('FORBIDDEN');
    ch.is_archived = !!archived;
    await ch.save();
    emitChannelListChanged(this._orgIdSlug);
    return ch.toObject();
  }

  async setNotifyPreference({ channelId, userId, notify }) {
    const allowed = ['all', 'mentions', 'muted'];
    if (!allowed.includes(notify)) throw new Error('INVALID_NOTIFY');
    const res = await this.Membership.findOneAndUpdate(
      { channel_id: toObjectId(channelId), user_id: toObjectId(userId) },
      { $set: { notify } },
      { new: true }
    ).lean();
    return res;
  }

  // ---------- group mention expansion ----------

  /**
   * Expand `@everyone`, `@<department-slug>` tokens into a flat list of user
   * ids. Used at send time to populate `mentioned_user_ids` so the receiving
   * users get pinged via socket.
   */
  async expandGroupMentions({ body, channelId = null }) {
    const text = String(body || '');
    const expansions = [];
    const slugify = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, '-');

    // `@all` is the channel-scoped flavour — expands to every member of THIS
    // channel only. Use this for "ping the room" without spamming the whole org.
    if (channelId && /@all\b/i.test(text)) {
      const rows = await this.Membership.find({ channel_id: toObjectId(channelId) })
        .select('user_id').lean();
      for (const r of rows) if (r.user_id) expansions.push(r.user_id);
    }

    // `@everyone` stays org-wide — kept for backward compat but rarely the
    // right pick. Channel `@all` is what the picker offers by default.
    if (/@everyone\b/i.test(text)) {
      const users = await this.User.find({ status: 'active' }).select('_id').lean();
      for (const u of users) expansions.push(u._id);
    }

    const departments = await this.Department.find({ is_active: true }).select('_id name').lean();
    for (const d of departments) {
      const slug = slugify(d.name);
      const re = new RegExp(`@${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(text)) {
        const members = await this.BoardMember.find({ department: d.name, user_id: { $exists: true } })
          .select('user_id').lean();
        for (const m of members) {
          if (m.user_id) expansions.push(m.user_id);
        }
      }
    }
    return expansions;
  }

  // ---------- compliance mention search ----------

  /**
   * Returns a result set for the #-mention picker. Both modules and entities
   * are filtered against the requesting user's `permissions`.
   *
   * Result composition is balanced so entities aren't crowded out by the long
   * module list:
   *   - Modules are capped at MODULE_CAP (and ranked by query match strength).
   *   - Entities get up to ENTITY_PER_TYPE per collection.
   *   - When the user typed a query, entities lead (more specific intent).
   */
  async searchComplianceTargets({ q = '', limit = 60, permissions = [] } = {}) {
    const MODULE_CAP = 10;
    const ENTITY_PER_TYPE = 5;
    const query = String(q || '').trim();
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = query ? new RegExp(escapeRe(query), 'i') : null;

    const allowedModules = COMPLIANCE_MODULE_TARGETS
      .filter((m) => canViewModuleSync(permissions, m.moduleId))
      .filter((m) => !re || re.test(m.label) || re.test(m.id));

    // Rank module matches by where the query hits the label (prefix > word > anywhere).
    const rankedModules = re
      ? allowedModules
          .map((m) => {
            const lbl = m.label.toLowerCase();
            const qLower = query.toLowerCase();
            let rank = 3;
            if (lbl.startsWith(qLower)) rank = 0;
            else if (new RegExp(`\\b${escapeRe(qLower)}`, 'i').test(m.label)) rank = 1;
            else if (lbl.includes(qLower)) rank = 2;
            return { m, rank };
          })
          .sort((a, b) => a.rank - b.rank)
          .map((x) => x.m)
      : allowedModules;

    const moduleResults = rankedModules.slice(0, MODULE_CAP).map((m) => ({
      kind: 'module',
      id: m.id,
      type: m.id,
      label: m.label,
      href: m.href,
      moduleId: m.moduleId
    }));

    const allowedEntityTargets = COMPLIANCE_ENTITY_TARGETS.filter(
      (t) => canViewModuleSync(permissions, t.moduleId)
    );

    // Run every entity-type search in parallel — each is its own collection
    // hit. With 13 types this drops picker latency dramatically.
    const entityResultArrays = await Promise.all(allowedEntityTargets.map(async (t) => {
      const Model = this.tenantDb.models[t.modelName] || this.tenantDb.model(t.modelName, t.schema);
      const filter = re ? { [t.titleField]: re } : {};
      const select = ['_id', t.titleField, t.statusField].filter(Boolean).join(' ');
      try {
        const docs = await Model.find(filter)
          .select(select)
          .sort({ updatedAt: -1, _id: -1 })
          .limit(ENTITY_PER_TYPE)
          .lean();
        return docs.map((d) => ({
          kind: 'entity',
          id: String(d._id),
          type: t.type,
          label: d[t.titleField] || `(untitled ${t.label})`,
          typeLabel: t.label,
          href: t.hrefBuilder(d._id),
          moduleId: t.moduleId,
          status: t.statusField ? (d[t.statusField] || null) : null
        }));
      } catch {
        // Collection may not exist yet for a tenant — skip silently.
        return [];
      }
    }));
    const entityResults = entityResultArrays.flat();

    // When the user typed a query, lead with entities (specific). When browsing,
    // lead with modules (overview).
    const ordered = re
      ? [...entityResults, ...moduleResults]
      : [...moduleResults, ...entityResults];

    return ordered.slice(0, Math.min(limit, 100));
  }

  // ---------- channel CRUD ----------

  async createPrivateChannel({ name, description = '', memberUserIds = [], creatorUserId }) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('NAME_REQUIRED');

    const org = await this._resolveOrgObjectId();
    const creator = toObjectId(creatorUserId);
    const memberObjIds = Array.from(new Set(
      [creator, ...memberUserIds.map(toObjectId)].map((id) => String(id))
    )).map((s) => new mongoose.Types.ObjectId(s));

    const channel = await this.Channel.create({
      org_id: org,
      kind: 'private',
      name: cleanName,
      description,
      member_user_ids: memberObjIds,
      posting_open: true,
      created_by_user_id: creator
    });

    const ops = memberObjIds.map((uid) => ({
      updateOne: {
        filter: { channel_id: channel._id, user_id: uid },
        update: { $setOnInsert: { org_id: org, channel_id: channel._id, user_id: uid, joined_at: new Date() } },
        upsert: true
      }
    }));
    if (ops.length) await this.Membership.bulkWrite(ops, { ordered: false });

    const result = await this.Channel.findById(channel._id)
      .populate('member_user_ids', 'first_name last_name email profile_picture_key')
      .lean();
    emitChannelListChanged(this._orgIdSlug);
    return await attachMemberAvatarUrls(result);
  }

  /** Returns true if the given user is allowed to manage members of this channel. */
  async _canManageChannel(channelId, userId) {
    const channel = await this.Channel.findById(toObjectId(channelId)).lean();
    if (!channel) return false;
    if (channel.kind === 'private') {
      // Any member can add others to a private channel.
      const m = await this.Membership.findOne({
        channel_id: channel._id,
        user_id: toObjectId(userId)
      }).lean();
      if (m) return true;
    }
    // Org owner can manage anything.
    const u = await this.User.findById(toObjectId(userId)).select('is_org_owner').lean();
    return !!u?.is_org_owner;
  }

  async addChannelMembers({ channelId, userIds, requesterUserId }) {
    if (!await this._canManageChannel(channelId, requesterUserId)) throw new Error('FORBIDDEN');
    const org = await this._resolveOrgObjectId();
    const ch = await this.Channel.findById(toObjectId(channelId));
    if (!ch) return null;

    const newIds = userIds.map(toObjectId);
    const existingSet = new Set(ch.member_user_ids.map((u) => String(u)));
    const toAdd = newIds.filter((u) => !existingSet.has(String(u)));
    if (toAdd.length === 0) return ch.toObject();

    ch.member_user_ids.push(...toAdd);
    await ch.save();

    const ops = toAdd.map((uid) => ({
      updateOne: {
        filter: { channel_id: ch._id, user_id: uid },
        update: { $setOnInsert: { org_id: org, channel_id: ch._id, user_id: uid, joined_at: new Date() } },
        upsert: true
      }
    }));
    if (ops.length) await this.Membership.bulkWrite(ops, { ordered: false });

    const out = await this.Channel.findById(ch._id)
      .populate('member_user_ids', 'first_name last_name email profile_picture_key')
      .lean();
    emitChannelListChanged(this._orgIdSlug);
    return await attachMemberAvatarUrls(out);
  }

  async removeChannelMember({ channelId, userId, requesterUserId }) {
    // A user may always remove themselves; otherwise managers only.
    if (String(userId) !== String(requesterUserId)) {
      if (!await this._canManageChannel(channelId, requesterUserId)) throw new Error('FORBIDDEN');
    }
    const ch = await this.Channel.findById(toObjectId(channelId));
    if (!ch) return null;
    ch.member_user_ids = ch.member_user_ids.filter((u) => String(u) !== String(userId));
    await ch.save();
    await this.Membership.deleteOne({ channel_id: ch._id, user_id: toObjectId(userId) });
    emitChannelListChanged(this._orgIdSlug);
    return ch.toObject();
  }

  /**
   * Update mutable channel settings.
   *  - Retention: allowed for org admins on any channel, AND for the creator
   *    of a private channel (they own it; it's their data).
   *  - Name / description: admin OR private-channel manager (any member).
   */
  async updateChannel({ channelId, requesterUserId, isAdmin, patch }) {
    const ch = await this.Channel.findById(toObjectId(channelId));
    if (!ch) return null;

    const isPrivate = ch.kind === 'private';
    const isCreator = isPrivate && String(ch.created_by_user_id) === String(requesterUserId);

    const wantsRetention = patch.retention_days !== undefined;
    if (wantsRetention && !isAdmin && !isCreator) throw new Error('FORBIDDEN');

    const wantsRename = patch.name !== undefined || patch.description !== undefined;
    if (wantsRename) {
      const can = isAdmin || await this._canManageChannel(channelId, requesterUserId);
      if (!can) throw new Error('FORBIDDEN');
    }

    if (patch.name !== undefined) ch.name = String(patch.name).trim();
    if (patch.description !== undefined) ch.description = String(patch.description);
    if (wantsRetention) {
      const days = Number(patch.retention_days);
      ch.retention_days = Number.isFinite(days) && days >= 0 ? Math.floor(days) : 0;
    }

    await ch.save();
    return ch.toObject();
  }

  // ---------- retention cleanup ----------

  /**
   * Permanently deletes attachments AND scrubs message bodies older than each
   * channel's retention window (retention_days = 0 means forever).
   *
   * Audit invariant preserved: `sender_user_id`, `createdAt`, `is_deleted: true`
   * remain so the audit trail can prove a message existed even after content
   * has been removed.
   */
  async runRetentionSweep() {
    const channels = await this.Channel.find({ retention_days: { $gt: 0 } })
      .select('_id retention_days')
      .lean();
    let attachmentsRemoved = 0;
    let messagesPurged = 0;

    for (const c of channels) {
      const cutoff = new Date(Date.now() - c.retention_days * 24 * 60 * 60 * 1000);
      const expired = await this.Message.find({
        channel_id: c._id,
        createdAt: { $lt: cutoff }
      }).select('_id attachments body is_deleted');

      for (const m of expired) {
        // Best-effort S3 deletes — never throw out of the sweep.
        for (const att of (m.attachments || [])) {
          try {
            await deleteFromS3(att.s3_key);
            attachmentsRemoved += 1;
          } catch { /* ignore */ }
        }
        m.attachments = [];
        // Past retention — scrub body and soft-delete. Edits[] history is
        // also wiped because it would otherwise leak prior content.
        if (!m.is_deleted) {
          m.is_deleted = true;
          m.deleted_at = new Date();
          messagesPurged += 1;
        }
        m.body = '';
        m.edits = [];
        await m.save();
      }
    }

    return { attachmentsRemoved, messagesPurged, channelsProcessed: channels.length };
  }

  // ---------- response helper ----------

  /**
   * Apply the standard populate set + signed avatar URLs onto messages.
   * Accepts either a Mongoose Query (returns populated lean array/doc) OR
   * a plain doc/array to enrich in-place.
   */
  async _populateForResponse(queryOrDocs) {
    let docs;
    if (queryOrDocs && typeof queryOrDocs.populate === 'function') {
      docs = await queryOrDocs
        .populate('sender_user_id', 'first_name last_name email profile_picture_key')
        .populate('mentioned_user_ids', 'first_name last_name email profile_picture_key')
        .populate('pinned_by_user_id', 'first_name last_name email')
        .lean();
    } else {
      docs = queryOrDocs;
    }
    if (!docs) return docs;
    const arr = Array.isArray(docs) ? docs : [docs];
    await Promise.all(arr.map(async (m) => {
      if (m.sender_user_id?.profile_picture_key) {
        m.sender_user_id.profile_picture_url = await safeFileUrl(m.sender_user_id.profile_picture_key);
      }
      if (Array.isArray(m.mentioned_user_ids)) {
        await Promise.all(m.mentioned_user_ids.map(async (u) => {
          if (u.profile_picture_key) {
            u.profile_picture_url = await safeFileUrl(u.profile_picture_key);
          }
        }));
      }
      if (Array.isArray(m.attachments) && m.attachments.length > 0) {
        await Promise.all(m.attachments.map(async (a) => {
          if (a.s3_key) a.url = await safeFileUrl(a.s3_key);
        }));
      }
    }));
    return Array.isArray(docs) ? arr : arr[0];
  }
}

/**
 * Cached, throw-safe S3 signed URL. URLs are valid 7 days; we hold them for
 * ~6 days so the next list call doesn't pay for a fresh sign every avatar.
 */
async function safeFileUrl(key) {
  if (!key) return null;
  const cached = _signedUrlCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.url;
  try {
    const url = await getFileUrl(key, 604800);
    _signedUrlCache.set(key, { url, expiresAt: now + SIGNED_URL_TTL_MS });
    return url;
  } catch {
    return null;
  }
}

/**
 * Walk one channel or an array of channels and resolve `profile_picture_url`
 * on every populated `member_user_ids` entry. Without this the frontend
 * Avatar component falls back to initials for DMs because populate only
 * returns the S3 key, not a signed URL. Mutates in place and returns input.
 */
async function attachMemberAvatarUrls(input) {
  const channels = Array.isArray(input) ? input : [input];
  const keys = new Set();
  for (const c of channels) {
    for (const u of c?.member_user_ids || []) {
      if (u && typeof u === 'object' && u.profile_picture_key) keys.add(u.profile_picture_key);
    }
  }
  if (keys.size === 0) return input;
  const urlByKey = new Map();
  await Promise.all([...keys].map(async (k) => urlByKey.set(k, await safeFileUrl(k))));
  for (const c of channels) {
    for (const u of c?.member_user_ids || []) {
      if (u && typeof u === 'object' && u.profile_picture_key) {
        u.profile_picture_url = urlByKey.get(u.profile_picture_key) || null;
      }
    }
  }
  return input;
}
