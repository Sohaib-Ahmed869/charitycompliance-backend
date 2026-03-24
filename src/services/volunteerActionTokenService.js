import crypto from 'crypto';
import { getRouterConnection } from '../config/database.js';

const COLLECTION = 'volunteer_action_tokens';
const DEFAULT_EXPIRY_DAYS = 30;

function toDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function createVolunteerActionToken({
  orgId,
  boardMemberId,
  actionType,
  email,
  expiresAt,
  metadata = {},
}) {
  const routerDb = getRouterConnection();
  const col = routerDb.collection(COLLECTION);
  const token = crypto.randomBytes(24).toString('hex');
  const expiry =
    toDateOrNull(expiresAt) || new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const doc = {
    token,
    org_id: String(orgId),
    board_member_id: String(boardMemberId),
    action_type: actionType,
    email: (email || '').toLowerCase().trim(),
    is_active: true,
    expires_at: expiry,
    created_at: new Date(),
    updated_at: new Date(),
    used_count: 0,
    last_used_at: null,
    metadata,
  };

  await col.insertOne(doc);
  return doc;
}

export async function resolveVolunteerActionToken(token, expectedType = null) {
  const routerDb = getRouterConnection();
  const col = routerDb.collection(COLLECTION);
  const query = { token, is_active: true };
  if (expectedType) query.action_type = expectedType;
  const doc = await col.findOne(query);
  if (!doc) return null;
  if (doc.expires_at && new Date() > new Date(doc.expires_at)) return null;
  return doc;
}

export async function markVolunteerActionTokenUsed(token) {
  const routerDb = getRouterConnection();
  const col = routerDb.collection(COLLECTION);
  await col.updateOne(
    { token },
    {
      $inc: { used_count: 1 },
      $set: { last_used_at: new Date(), updated_at: new Date() },
    }
  );
}

