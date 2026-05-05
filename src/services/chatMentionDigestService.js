/**
 * Chat @-mention email digest.
 *
 * Periodic sweep that finds @mentions still unread after a threshold (default
 * 30 min) and emails the mentioned user a single grouped digest. The
 * `chat_mention_digest_logs` collection records every (user, message) pair
 * already emailed so the same mention is never digested twice.
 */

import { getRouterConnection } from '../config/database.js';
import { getTenantConnection } from '../db/connectionManager.js';
import chatChannelSchema from '../db/schemas/platform/chatChannelSchema.js';
import chatChannelMembershipSchema from '../db/schemas/platform/chatChannelMembershipSchema.js';
import chatMessageSchema from '../db/schemas/platform/chatMessageSchema.js';
import chatMentionDigestLogSchema from '../db/schemas/platform/chatMentionDigestLogSchema.js';
import { UserRepository } from '../repositories/userRepository.js';
import emailService, { buildEmailTemplate } from './emailService.js';
import { logError, logInfo } from '../utils/logger.js';

const TICK_MS    = Number(process.env.CHAT_MENTION_DIGEST_TICK_MS)    || 15 * 60 * 1000;
const THRESHOLD_MS = Number(process.env.CHAT_MENTION_DIGEST_THRESHOLD_MS) || 30 * 60 * 1000;

async function listOrgIdsFromRouterDb() {
  const routerDb = await getRouterConnection();
  const orgs = await routerDb.collection('organizations').find({}).project({ org_id: 1 }).toArray();
  return (orgs || []).map((o) => String(o.org_id || '').trim()).filter(Boolean);
}

function fullName(u) {
  if (!u) return 'Someone';
  const fn = u.first_name || u.firstName || '';
  const ln = u.last_name || u.lastName || '';
  return `${fn} ${ln}`.trim() || u.email || 'Someone';
}

function digestEmailHtml({ recipientName, items, frontendBase }) {
  // Each missed mention as a styled row inside the brand-template body.
  const rows = items.map((it) => {
    const channelLabel = it.channel?.kind === 'general' ? '#general'
      : it.channel?.kind === 'announcements' ? '#announcements'
      : it.channel?.kind === 'dm' ? 'a direct message'
      : `#${it.channel?.name || 'channel'}`;
    const preview = (it.message.body || '').slice(0, 240);
    return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 12px;">
        <tr>
          <td style="padding: 12px 14px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px;">
            <div style="font-size: 13px; color: #0f172a; margin-bottom: 4px; text-align: left;">
              <strong>${fullName(it.message.sender_user_id)}</strong>
              <span style="color: #64748b;">mentioned you in ${channelLabel}</span>
            </div>
            <div style="font-size: 13px; color: #334155; white-space: pre-wrap; text-align: left; line-height: 1.5;">${preview}</div>
          </td>
        </tr>
      </table>`;
  }).join('');

  const intro = `
    <p style="margin: 0 0 8px 0; font-size: 14px; line-height: 1.55; color: #475569;">Hi ${recipientName},</p>
    <p style="margin: 0 0 18px 0; font-size: 14px; line-height: 1.55; color: #475569;">Here's what you missed in chat.</p>
    ${rows}
  `;

  return buildEmailTemplate({
    heading: `${items.length} new chat mention${items.length === 1 ? '' : 's'}`,
    bodyHtml: intro,
    buttonText: 'Open chat',
    buttonLink: `${frontendBase}/chat`,
    infoBoxLines: ["You're receiving this because you were @mentioned and hadn't opened the chat for a while."]
  });
}

async function processOrg(orgId) {
  const tenantDb = await getTenantConnection(orgId);
  const Channel    = tenantDb.models.ChatChannel               || tenantDb.model('ChatChannel', chatChannelSchema);
  const Membership = tenantDb.models.ChatChannelMembership     || tenantDb.model('ChatChannelMembership', chatChannelMembershipSchema);
  const Message    = tenantDb.models.ChatMessage               || tenantDb.model('ChatMessage', chatMessageSchema);
  const DigestLog  = tenantDb.models.ChatMentionDigestLog      || tenantDb.model('ChatMentionDigestLog', chatMentionDigestLogSchema);
  const userRepo   = new UserRepository(tenantDb);

  const cutoff = new Date(Date.now() - THRESHOLD_MS);

  // Candidate messages: have at least one mention, older than threshold, not deleted.
  const candidates = await Message.find({
    'mentioned_user_ids.0': { $exists: true },
    is_deleted: false,
    createdAt: { $lte: cutoff }
  })
    .sort({ createdAt: -1 })
    .limit(500) // safety cap per tick
    .populate('sender_user_id', 'first_name last_name email')
    .lean();

  if (candidates.length === 0) return { sent: 0 };

  // Group pending items by recipient user.
  const pendingByUser = new Map();
  for (const m of candidates) {
    for (const uid of (m.mentioned_user_ids || [])) {
      const userId = String(uid);
      if (String(m.sender_user_id?._id || m.sender_user_id) === userId) continue; // self-mentions don't email

      // Skip if the user has already read past this message (membership.last_read_at >= createdAt).
      const membership = await Membership.findOne({ channel_id: m.channel_id, user_id: uid }).lean();
      if (membership?.last_read_at && new Date(membership.last_read_at) >= new Date(m.createdAt)) continue;

      // Skip if already digested.
      const already = await DigestLog.findOne({ user_id: uid, message_id: m._id }).lean();
      if (already) continue;

      const channel = await Channel.findById(m.channel_id).select('name kind').lean();
      const item = { message: m, channel };
      if (!pendingByUser.has(userId)) pendingByUser.set(userId, []);
      pendingByUser.get(userId).push(item);
    }
  }

  if (pendingByUser.size === 0) return { sent: 0 };

  const frontendBase = String(process.env.FRONTEND_URL || '').split(',')[0].trim() || 'http://localhost:5173';
  let sent = 0;

  for (const [userId, items] of pendingByUser.entries()) {
    try {
      const user = await userRepo.findById(userId);
      if (!user?.email) continue;
      await emailService.sendEmail({
        to: user.email,
        subject: `You were mentioned in chat (${items.length} new)`,
        html: digestEmailHtml({ recipientName: fullName(user), items, frontendBase })
      });

      // Mark every digested mention so we never re-email it.
      const ops = items.map((it) => ({
        updateOne: {
          filter: { user_id: userId, message_id: it.message._id },
          update: { $setOnInsert: { user_id: userId, message_id: it.message._id, sent_at: new Date() } },
          upsert: true
        }
      }));
      await DigestLog.bulkWrite(ops, { ordered: false });
      sent += 1;
    } catch (err) {
      logError('Mention digest email failed', { orgId, userId, error: err?.message });
    }
  }

  return { sent };
}

export async function runChatMentionDigestOnce() {
  const orgIds = await listOrgIdsFromRouterDb();
  let total = 0;
  for (const orgId of orgIds) {
    try {
      const r = await processOrg(orgId);
      total += r.sent;
    } catch (err) {
      logError('Chat mention digest failed for tenant', { orgId, error: err?.message });
    }
  }
  logInfo('Chat mention digest sweep complete', { tenants: orgIds.length, emailsSent: total });
  return { tenants: orgIds.length, emailsSent: total };
}

export function startChatMentionDigestScheduler() {
  const enabled = String(process.env.CHAT_MENTION_DIGEST_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    logInfo('Chat mention digest scheduler disabled');
    return;
  }
  setInterval(() => {
    runChatMentionDigestOnce().catch((err) => logError('Chat mention digest tick failed', err));
  }, TICK_MS);
  logInfo('Chat mention digest scheduler started', { tickMs: TICK_MS, thresholdMs: THRESHOLD_MS });
}
