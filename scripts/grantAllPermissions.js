/**
 * grantAllPermissions.js — give a position full module permissions (view/edit/
 * delete on every module) WITHOUT making the holder an admin.
 *
 * Non-admin permissions are recomputed from the holder's position
 * module_permissions on each request, so setting them here grants the person
 * full access to every module. Does NOT add a *:* wildcard (that's admin).
 *
 * Defaults target Kelly Kapoor's Office Administrator position in org "testing".
 * Requires backend env (ROUTER_DB_URI + MASTER_KEY_HEX). Run from the backend:
 *   $env:PERM_ORG="testing"; node scripts/grantAllPermissions.js
 * Override: PERM_ORG, PERM_POSITION_ID.
 */

import dotenv from 'dotenv';
import dns from 'node:dns';
import { connectRouterDB, closeRouterDB } from '../src/config/database.js';
import { getTenantConnection } from '../src/db/connectionManager.js';
import { PositionRepository } from '../src/repositories/positionRepository.js';

dotenv.config();
try { dns.setServers(['1.1.1.1', '8.8.8.8', ...dns.getServers()]); } catch { /* ignore */ }

const ORG         = process.env.PERM_ORG || 'testing';
const POSITION_ID = process.env.PERM_POSITION_ID || '6a7581ee32c70ee96d444891'; // Kelly's Office Administrator

// Full sidebar module list (mirrors MODULE_IDS in middleware/auth.js).
const MODULE_IDS = [
  'dashboard', 'calendar', 'meetings', 'approval_workflow', 'audit_trail', 'complaints',
  'charity_admin', 'charity_admin_registrations', 'charity_admin_responsible_people',
  'charity_admin_governing_docs', 'charity_admin_approval_thresholds',
  'policies', 'human_resources', 'financial_mgmt', 'risk_mgmt', 'programs', 'grants_donors',
  'reporting', 'systems_legal', 'donation_boxes', 'members', 'related_party_transactions',
  'access_control',
];

(async () => {
  await connectRouterDB();
  const db = await getTenantConnection(ORG);
  const positionRepo = new PositionRepository(db);

  const pos = await positionRepo.findById(POSITION_ID);
  if (!pos) throw new Error(`Position ${POSITION_ID} not found in org "${ORG}".`);

  const module_permissions = MODULE_IDS.map((id) => ({ module_id: id, view: true, edit: true, delete: true }));
  await positionRepo.update(POSITION_ID, { module_permissions });

  console.log(`Granted full view/edit/delete on all ${MODULE_IDS.length} modules to position ` +
    `"${pos.title || POSITION_ID}" (${POSITION_ID}) in org "${ORG}".`);
  console.log('No *:* wildcard added (not an admin). Effective within ~20s (runtime-permission cache TTL) ' +
    'on the holder\'s next request.');

  await closeRouterDB();
  process.exit(0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
