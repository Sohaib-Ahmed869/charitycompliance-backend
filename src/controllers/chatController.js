/**
 * Chat Controller
 *
 * HTTP handlers for the in-platform chat feature. Auth + tenant resolution
 * happens at the route layer via authAndResolveTenant; this layer only deals
 * with request shaping and repository calls.
 */

import { ChatRepository } from '../repositories/chatRepository.js';
import { UserRepository } from '../repositories/userRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { uploadToS3 } from '../services/s3Service.js';
import { getOnlineUserIds } from '../services/chatSocketService.js';

/**
 * Org owner OR a JWT 'admin' role count as admin for chat purposes.
 * `req.user` does not carry `is_org_owner`, so we look it up from the User
 * doc — same pattern as complaintController.
 */
const resolveIsAdmin = async (req) => {
  if (Array.isArray(req.user?.roles) && req.user.roles.includes('admin')) return true;
  try {
    const userRepo = new UserRepository(req.tenantDb);
    const user = await userRepo.findById(req.user.userId);
    return !!user?.is_org_owner;
  } catch {
    return false;
  }
};

export const listChannels = asyncHandler(async (req, res) => {
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  await repo.ensureCoreChannels(req.orgId, req.user.userId);
  const channels = await repo.listChannelsForUser(req.orgId, req.user.userId);
  res.json({ success: true, data: channels });
});

export const listMessages = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const repo = new ChatRepository(req.tenantDb, req.orgId);

  const channel = await repo.getChannelForUser(req.orgId, channelId, req.user.userId);
  if (!channel) {
    return res.status(404).json({
      success: false,
      error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' }
    });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const beforeId = req.query.before || null;
  const messages = await repo.listMessages(channelId, { limit, beforeId });
  const starredIds = await repo.getStarredIds(req.user.userId, messages.map((m) => m._id));
  const enriched = messages.map((m) => ({ ...m, is_starred: starredIds.has(String(m._id)) }));
  res.json({ success: true, data: enriched });
});

export const postMessage = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const { body, replyToMessageId, parentMessageId, mentionedUserIds, attachments } = req.body || {};
  const repo = new ChatRepository(req.tenantDb, req.orgId);

  // Posting permission: kind=general/announcements require admin (posting_open=false on those).
  const channel = await repo.getChannelForUser(req.orgId, channelId, req.user.userId);
  if (!channel) {
    return res.status(404).json({
      success: false,
      error: { code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' }
    });
  }
  const userIsAdmin = await resolveIsAdmin(req);
  if (!channel.posting_open && !userIsAdmin) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'POSTING_RESTRICTED',
        message: 'Only administrators can post in this channel.'
      }
    });
  }

  try {
    const msg = await repo.createMessage({
      orgId: req.orgId,
      channelId,
      senderUserId: req.user.userId,
      body,
      replyToMessageId,
      parentMessageId,
      mentionedUserIds: Array.isArray(mentionedUserIds) ? mentionedUserIds : [],
      attachments: Array.isArray(attachments) ? attachments : []
    });
    res.status(201).json({ success: true, data: msg });
  } catch (err) {
    if (err.message === 'EMPTY_BODY') {
      return res.status(400).json({
        success: false,
        error: { code: 'EMPTY_BODY', message: 'Message body cannot be empty.' }
      });
    }
    if (err.message === 'NOT_A_MEMBER') {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_A_MEMBER', message: 'You are not a member of this channel.' }
      });
    }
    throw err;
  }
});

export const editMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const { body } = req.body || {};
  const repo = new ChatRepository(req.tenantDb, req.orgId);

  try {
    const msg = await repo.editMessage({ messageId, userId: req.user.userId, body });
    if (!msg) {
      return res.status(404).json({
        success: false,
        error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' }
      });
    }
    res.json({ success: true, data: msg });
  } catch (err) {
    if (err.message === 'NOT_AUTHOR') {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_AUTHOR', message: 'You can only edit your own messages.' }
      });
    }
    if (err.message === 'EMPTY_BODY') {
      return res.status(400).json({
        success: false,
        error: { code: 'EMPTY_BODY', message: 'Message body cannot be empty.' }
      });
    }
    throw err;
  }
});

export const deleteMessage = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const repo = new ChatRepository(req.tenantDb, req.orgId);

  try {
    const removed = await repo.softDeleteMessage({
      messageId,
      userId: req.user.userId,
      isAdmin: await resolveIsAdmin(req)
    });
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: { code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' }
      });
    }
    res.json({ success: true, data: { _id: removed._id, is_deleted: true } });
  } catch (err) {
    if (err.message === 'NOT_AUTHOR') {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_AUTHOR', message: 'You can only delete your own messages.' }
      });
    }
    throw err;
  }
});

export const markRead = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const { messageIds } = req.body || {};
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  await repo.markChannelRead({ channelId, userId: req.user.userId });
  if (Array.isArray(messageIds) && messageIds.length > 0) {
    await repo.markMessagesRead({ userId: req.user.userId, channelId, messageIds });
  }
  res.json({ success: true });
});

export const getReadInfo = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  const map = await repo.getReadInfoForMessages([messageId]);
  res.json({ success: true, data: map[String(messageId)] || [] });
});

// ---------- reactions ----------

export const toggleReaction = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const { emoji } = req.body || {};
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  try {
    const msg = await repo.toggleReaction({ messageId, userId: req.user.userId, emoji });
    if (!msg) {
      return res.status(404).json({ success: false, error: { code: 'MESSAGE_NOT_FOUND' } });
    }
    res.json({ success: true, data: msg });
  } catch (err) {
    if (err.message === 'EMPTY_EMOJI') {
      return res.status(400).json({ success: false, error: { code: 'EMPTY_EMOJI', message: 'Emoji is required.' } });
    }
    throw err;
  }
});

// ---------- pin ----------

export const setPin = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const { pinned } = req.body || {};
  if (!(await resolveIsAdmin(req))) {
    return res.status(403).json({
      success: false,
      error: { code: 'PIN_RESTRICTED', message: 'Only administrators can pin or unpin messages.' }
    });
  }
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  const msg = await repo.setPin({ messageId, userId: req.user.userId, pinned: !!pinned });
  if (!msg) return res.status(404).json({ success: false, error: { code: 'MESSAGE_NOT_FOUND' } });
  res.json({ success: true, data: msg });
});

export const listPinned = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  const channel = await repo.getChannelForUser(req.orgId, channelId, req.user.userId);
  if (!channel) return res.status(404).json({ success: false, error: { code: 'CHANNEL_NOT_FOUND' } });
  const messages = await repo.listPinnedMessages(channelId);
  res.json({ success: true, data: messages });
});

// ---------- star ----------

export const setStar = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const { starred } = req.body || {};
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  const ok = await repo.setStar({ messageId, userId: req.user.userId, starred: !!starred });
  if (!ok) return res.status(404).json({ success: false, error: { code: 'MESSAGE_NOT_FOUND' } });
  res.json({ success: true });
});

export const listStarred = asyncHandler(async (req, res) => {
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  const messages = await repo.listStarredMessages(req.user.userId);
  // Mark each as starred so the UI doesn't have to round-trip.
  res.json({ success: true, data: messages.map((m) => ({ ...m, is_starred: true })) });
});

// ---------- presence ----------

export const getPresence = asyncHandler(async (req, res) => {
  const ids = getOnlineUserIds(req.orgId);
  res.json({ success: true, data: ids });
});

// ---------- mention picker ----------

export const listMentionableUsers = asyncHandler(async (req, res) => {
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  const users = await repo.listOrgUsersForMention({
    search: req.query.q || '',
    limit: req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 30, 100) : 30,
    channelId: req.query.channelId || null
  });
  res.json({ success: true, data: users });
});

// ---------- file upload ----------

/**
 * Uploads files to S3 under the chat/ category and returns metadata for each.
 * The caller (frontend) then attaches that metadata to a subsequent
 * postMessage call. Files themselves never live on the message before send.
 */
export const uploadAttachments = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  const channel = await repo.getChannelForUser(req.orgId, channelId, req.user.userId);
  if (!channel) {
    return res.status(404).json({ success: false, error: { code: 'CHANNEL_NOT_FOUND' } });
  }
  if (!channel.posting_open && !(await resolveIsAdmin(req))) {
    return res.status(403).json({
      success: false,
      error: { code: 'POSTING_RESTRICTED', message: 'Only administrators can post in this channel.' }
    });
  }

  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) {
    return res.status(400).json({ success: false, error: { code: 'NO_FILES', message: 'At least one file is required.' } });
  }

  const uploaded = [];
  for (const f of files) {
    const result = await uploadToS3(f.buffer, f.originalname, f.mimetype, req.orgId, 'chat');
    uploaded.push({
      s3_key: result.key,
      filename: f.originalname,
      mime_type: f.mimetype,
      size_bytes: f.size
    });
  }
  res.status(201).json({ success: true, data: uploaded });
});

// ---------- compliance search ----------

export const searchCompliance = asyncHandler(async (req, res) => {
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  const targets = await repo.searchComplianceTargets({
    q: req.query.q || '',
    limit: req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 60, 100) : 60,
    permissions: Array.isArray(req.user?.permissions) ? req.user.permissions : []
  });
  res.json({ success: true, data: targets });
});

// ---------- channels CRUD ----------

export const createChannel = asyncHandler(async (req, res) => {
  const { name, description, memberUserIds } = req.body || {};
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  try {
    const channel = await repo.createPrivateChannel({
      name,
      description,
      memberUserIds: Array.isArray(memberUserIds) ? memberUserIds : [],
      creatorUserId: req.user.userId
    });
    res.status(201).json({ success: true, data: channel });
  } catch (err) {
    if (err.message === 'NAME_REQUIRED') {
      return res.status(400).json({ success: false, error: { code: 'NAME_REQUIRED', message: 'Channel name is required.' } });
    }
    throw err;
  }
});

export const addMembers = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const { userIds } = req.body || {};
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ success: false, error: { code: 'NO_USERS', message: 'userIds is required.' } });
  }
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  try {
    const ch = await repo.addChannelMembers({ channelId, userIds, requesterUserId: req.user.userId });
    if (!ch) return res.status(404).json({ success: false, error: { code: 'CHANNEL_NOT_FOUND' } });
    res.json({ success: true, data: ch });
  } catch (err) {
    if (err.message === 'FORBIDDEN') {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You cannot manage members of this channel.' } });
    }
    throw err;
  }
});

export const removeMember = asyncHandler(async (req, res) => {
  const { channelId, userId } = req.params;
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  try {
    const ch = await repo.removeChannelMember({ channelId, userId, requesterUserId: req.user.userId });
    if (!ch) return res.status(404).json({ success: false, error: { code: 'CHANNEL_NOT_FOUND' } });
    res.json({ success: true, data: ch });
  } catch (err) {
    if (err.message === 'FORBIDDEN') {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You cannot remove members from this channel.' } });
    }
    throw err;
  }
});

// ---------- threads ----------

export const getThread = asyncHandler(async (req, res) => {
  const { messageId } = req.params;
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  const result = await repo.listThread(messageId);
  if (!result) return res.status(404).json({ success: false, error: { code: 'MESSAGE_NOT_FOUND' } });
  res.json({ success: true, data: result });
});

// ---------- DM ----------

export const createOrFindDm = asyncHandler(async (req, res) => {
  const { otherUserId } = req.body || {};
  if (!otherUserId) {
    return res.status(400).json({ success: false, error: { code: 'OTHER_USER_REQUIRED', message: 'otherUserId is required.' } });
  }
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  try {
    const channel = await repo.findOrCreateDm({ requesterUserId: req.user.userId, otherUserId });
    res.status(200).json({ success: true, data: channel });
  } catch (err) {
    if (err.message === 'SELF_DM') {
      return res.status(400).json({ success: false, error: { code: 'SELF_DM', message: "You can't DM yourself." } });
    }
    throw err;
  }
});

// ---------- search ----------

export const searchMessages = asyncHandler(async (req, res) => {
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  const messages = await repo.searchMessages({
    requesterUserId: req.user.userId,
    q: req.query.q || '',
    senderId: req.query.sender || null,
    since: req.query.since || null,
    until: req.query.until || null,
    hasAttachment: req.query.hasAttachment,
    limit: req.query.limit ? Math.min(parseInt(req.query.limit, 10) || 60, 200) : 60
  });
  res.json({ success: true, data: messages });
});

// ---------- archive / leave / mute ----------

export const archiveChannel = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const { archived } = req.body || {};
  const isAdmin = await resolveIsAdmin(req);
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  try {
    const ch = await repo.setChannelArchived({
      channelId,
      archived: !!archived,
      requesterUserId: req.user.userId,
      isAdmin
    });
    if (!ch) return res.status(404).json({ success: false, error: { code: 'CHANNEL_NOT_FOUND' } });
    res.json({ success: true, data: ch });
  } catch (err) {
    if (err.message === 'FORBIDDEN') {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Only administrators or the channel creator can archive this channel.' } });
    }
    throw err;
  }
});

export const leaveChannel = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  const ch = await repo.removeChannelMember({
    channelId,
    userId: req.user.userId,
    requesterUserId: req.user.userId
  });
  if (!ch) return res.status(404).json({ success: false, error: { code: 'CHANNEL_NOT_FOUND' } });
  res.json({ success: true });
});

export const setNotify = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const { notify } = req.body || {};
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  try {
    const m = await repo.setNotifyPreference({ channelId, userId: req.user.userId, notify });
    if (!m) return res.status(404).json({ success: false, error: { code: 'NOT_A_MEMBER' } });
    res.json({ success: true, data: { notify: m.notify } });
  } catch (err) {
    if (err.message === 'INVALID_NOTIFY') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_NOTIFY', message: 'notify must be one of all, mentions, muted.' } });
    }
    throw err;
  }
});

export const updateChannel = asyncHandler(async (req, res) => {
  const { channelId } = req.params;
  const { name, description, retention_days } = req.body || {};
  const isAdmin = await resolveIsAdmin(req);
  const repo = new ChatRepository(req.tenantDb, req.orgId);
  try {
    const ch = await repo.updateChannel({
      channelId,
      requesterUserId: req.user.userId,
      isAdmin,
      patch: {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(retention_days !== undefined ? { retention_days } : {})
      }
    });
    if (!ch) return res.status(404).json({ success: false, error: { code: 'CHANNEL_NOT_FOUND' } });
    res.json({ success: true, data: ch });
  } catch (err) {
    if (err.message === 'FORBIDDEN') {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You do not have permission to make that change.' }
      });
    }
    throw err;
  }
});
