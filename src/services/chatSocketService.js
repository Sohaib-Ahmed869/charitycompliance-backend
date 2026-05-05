/**
 * Chat Socket.IO server.
 *
 * One io instance is attached to the HTTP server. On handshake we verify the
 * JWT, derive `{ userId, orgId }`, and join the socket to:
 *   - `org:<orgId>` — channel-list updates for the org
 *   - `user:<orgId>:<userId>` — direct events to one user (e.g. mention pings)
 *
 * Per-channel rooms are joined lazily when the client emits `chat:join`
 * after the user opens a channel. The frontend leaves the room on switch.
 */

import { Server as IOServer } from 'socket.io';
import jwt from 'jsonwebtoken';
import { getTenantConnection } from '../db/connectionManager.js';
import { UserRepository } from '../repositories/userRepository.js';
import { logError, logInfo } from '../utils/logger.js';

let io = null;

const orgRoom = (orgId) => `org:${orgId}`;
const userRoom = (orgId, userId) => `user:${orgId}:${userId}`;
const channelRoom = (channelId) => `chan:${channelId}`;

/**
 * Presence map: orgId → Map<userId, connectionCount>.
 * A user is "online" while they have at least one active socket. Multiple
 * tabs increment the count; closing one tab keeps them online.
 */
const presence = new Map();

function _adjustPresence(orgId, userId, delta) {
  if (!orgId || !userId) return null;
  if (!presence.has(orgId)) presence.set(orgId, new Map());
  const m = presence.get(orgId);
  const cur = m.get(userId) || 0;
  const next = Math.max(0, cur + delta);
  if (next === 0) m.delete(userId);
  else m.set(userId, next);
  // The user transitioned online↔offline only when count crosses 0.
  const transitioned = (delta > 0 && cur === 0) || (delta < 0 && next === 0);
  return { online: next > 0, transitioned };
}

export function getOnlineUserIds(orgId) {
  if (!orgId) return [];
  return Array.from(presence.get(orgId)?.keys() || []);
}

export function initChatSocket(httpServer) {
  io = new IOServer(httpServer, {
    path: '/socket.io',
    // Permissive — JWT verification on handshake is what actually gates access.
    // Reflecting origin handles every dev/prod combination without env juggling.
    cors: {
      origin: (origin, cb) => cb(null, true),
      credentials: true
    },
    transports: ['websocket', 'polling']
  });

  // Surface any low-level engine connection failure (CORS, auth, transport, etc.).
  io.engine.on('connection_error', (err) => {
    logError('[chat-socket] engine connection_error', {
      code: err.code,
      message: err.message,
      type: err.type,
      context: err.context
    });
  });

  // Auth on handshake — token via `auth.token` (preferred) or query.token.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) {
        logError('[chat-socket] handshake rejected: NO_TOKEN', { origin: socket.handshake.headers.origin });
        return next(new Error('NO_TOKEN'));
      }
      if (!process.env.JWT_SECRET) {
        logError('[chat-socket] handshake rejected: JWT_SECRET not set on server');
        return next(new Error('SERVER_MISCONFIGURED'));
      }
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const orgId = String(decoded.orgId || '').toLowerCase().trim();
      if (!orgId || !decoded.userId) {
        logError('[chat-socket] handshake rejected: INVALID_TOKEN_PAYLOAD', { hasOrgId: !!orgId, hasUserId: !!decoded.userId });
        return next(new Error('INVALID_TOKEN_PAYLOAD'));
      }
      socket.data = { userId: String(decoded.userId), orgId };

      // Look up display name once at handshake so events (typing, presence)
      // can surface it without extra round-trips on every emit.
      try {
        const tenantDb = await getTenantConnection(orgId);
        const userRepo = new UserRepository(tenantDb);
        const u = await userRepo.findById(decoded.userId);
        if (u) {
          socket.data.profile = {
            _id: String(u._id),
            first_name: u.first_name || '',
            last_name: u.last_name || '',
            email: u.email || ''
          };
        }
      } catch (err) {
        // Non-fatal — events will fall back to userId only.
        logError('[chat-socket] profile lookup failed', { reason: err?.message });
      }
      logInfo('[chat-socket] handshake accepted', { userId: socket.data.userId, orgId: socket.data.orgId });
      next();
    } catch (err) {
      logError('[chat-socket] handshake rejected: jwt.verify failed', { reason: err?.message });
      next(new Error('INVALID_TOKEN'));
    }
  });

  io.on('connection', (socket) => {
    const { userId, orgId, profile } = socket.data || {};
    socket.join(orgRoom(orgId));
    socket.join(userRoom(orgId, userId));

    // Mark this user as online in this org and notify everyone in the org.
    const enter = _adjustPresence(orgId, userId, +1);
    if (enter?.transitioned) {
      io.to(orgRoom(orgId)).emit('chat:presence', { userId, online: true });
    }

    // Send the new socket the current online list so it doesn't have to fetch it.
    socket.emit('chat:presence:snapshot', { userIds: getOnlineUserIds(orgId) });

    socket.on('chat:join', (channelId) => {
      if (channelId) socket.join(channelRoom(String(channelId)));
    });
    socket.on('chat:leave', (channelId) => {
      if (channelId) socket.leave(channelRoom(String(channelId)));
    });

    // Typing indicator: relay to other members of the channel only. Includes
    // the typer's display profile so the receiver doesn't need a name lookup.
    socket.on('chat:typing', ({ channelId } = {}) => {
      if (!channelId) return;
      socket.to(channelRoom(String(channelId))).emit('chat:typing:user', {
        channelId: String(channelId),
        userId,
        user: profile || { _id: userId, first_name: '', last_name: '', email: '' },
        at: Date.now()
      });
    });

    socket.on('disconnect', () => {
      const leave = _adjustPresence(orgId, userId, -1);
      if (leave?.transitioned) {
        io.to(orgRoom(orgId)).emit('chat:presence', { userId, online: false });
      }
    });
  });

  logInfo('Chat Socket.IO server initialised', { path: '/socket.io' });
  return io;
}

/* ---------- emit helpers — used by controllers/repository after writes ---------- */

export function emitNewMessage(orgId, channelId, message) {
  if (!io) return;
  try {
    io.to(channelRoom(String(channelId))).emit('chat:message:new', { channelId: String(channelId), message });
    // Also notify the org so unread counts in the channel-list refresh for users
    // who don't have the channel currently open.
    io.to(orgRoom(orgId)).emit('chat:channel:touched', { channelId: String(channelId) });
  } catch (err) { logError('Socket emit failed (new message)', err); }
}

export function emitUpdatedMessage(orgId, channelId, message) {
  if (!io) return;
  try {
    io.to(channelRoom(String(channelId))).emit('chat:message:updated', { channelId: String(channelId), message });
  } catch (err) { logError('Socket emit failed (updated message)', err); }
}

export function emitDeletedMessage(orgId, channelId, messageId) {
  if (!io) return;
  try {
    io.to(channelRoom(String(channelId))).emit('chat:message:deleted', { channelId: String(channelId), messageId: String(messageId) });
  } catch (err) { logError('Socket emit failed (deleted message)', err); }
}

export function emitChannelListChanged(orgId) {
  if (!io) return;
  try {
    io.to(orgRoom(orgId)).emit('chat:channel-list:changed', { orgId });
  } catch (err) { logError('Socket emit failed (channel-list changed)', err); }
}

export function emitMention(orgId, userId, payload) {
  if (!io || !userId) return;
  try {
    io.to(userRoom(orgId, String(userId))).emit('chat:mention', payload);
  } catch (err) { logError('Socket emit failed (mention)', err); }
}

/**
 * Tell the channel "user X just read messages [...]" so the sender's read-by
 * indicator updates live. Frontend invalidates `['chat', 'reads', id]` for each id.
 */
export function emitMessagesRead(orgId, channelId, readerUserId, messageIds) {
  if (!io || !messageIds || messageIds.length === 0) return;
  try {
    io.to(channelRoom(String(channelId))).emit('chat:message:read', {
      channelId: String(channelId),
      readerUserId: String(readerUserId),
      messageIds: messageIds.map(String)
    });
  } catch (err) { logError('Socket emit failed (read)', err); }
}

export function getIo() { return io; }
