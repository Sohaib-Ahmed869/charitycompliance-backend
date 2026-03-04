/**
 * BCP Controller
 * 
 * HTTP request handlers for Business Continuity Plan operations
 */

import { BcpService } from '../services/bcpService.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validationResult } from 'express-validator';
import { getTenantConnection } from '../db/connectionManager.js';
import { BoardMemberRepository } from '../repositories/boardMemberRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { getMasterKeyHex } from '../config/encryption.js';
import { decryptBoardMemberFields } from '../utils/decryptBoardMember.js';

// ==================== EMERGENCY TEAM ====================

export const createEmergencyTeam = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }

  const bcpService = new BcpService(req.orgId);
  const team = await bcpService.createEmergencyTeam(req.body, req.user.userId);

  res.status(201).json({ success: true, data: team });
});

export const getEmergencyTeams = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const teams = await bcpService.getEmergencyTeams(req.query.status);

  res.json({ success: true, data: teams });
});

export const getEmergencyTeam = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const team = await bcpService.getEmergencyTeamById(req.params.teamId);

  if (!team) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Emergency team not found' }
    });
  }

  res.json({ success: true, data: team });
});

export const updateEmergencyTeam = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const team = await bcpService.updateEmergencyTeam(req.params.teamId, req.body);

  res.json({ success: true, data: team });
});

export const deleteEmergencyTeam = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  await bcpService.deleteEmergencyTeam(req.params.teamId);

  res.json({ success: true, message: 'Team archived successfully' });
});

// ==================== BCP RISKS ====================

export const createRisk = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }

  const bcpService = new BcpService(req.orgId);
  const risk = await bcpService.createRisk(req.body, req.user.userId);

  res.status(201).json({ success: true, data: risk });
});

export const getRisks = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const risks = await bcpService.getRisks(req.query);

  res.json({ success: true, data: risks });
});

export const getRisk = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const risk = await bcpService.getRiskById(req.params.riskId);

  if (!risk) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Risk not found' }
    });
  }

  res.json({ success: true, data: risk });
});

export const updateRisk = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const risk = await bcpService.updateRisk(req.params.riskId, req.body);

  res.json({ success: true, data: risk });
});

export const escalateRisk = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const risk = await bcpService.escalateRisk(req.params.riskId, req.body, req.user.userId);

  res.json({ success: true, data: risk });
});

export const getRiskStats = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const stats = await bcpService.getRiskStats();

  res.json({ success: true, data: stats });
});

export const getRisksDueForReview = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const risks = await bcpService.getRisksDueForReview();

  res.json({ success: true, data: risks });
});

// ==================== CREDENTIAL VAULT ====================

export const createCredential = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }

  const bcpService = new BcpService(req.orgId);
  const credential = await bcpService.createCredential(req.body, req.user.userId);

  res.status(201).json({ success: true, data: credential });
});

export const getCredentials = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const credentials = await bcpService.getCredentials(req.query);

  res.json({ success: true, data: credentials });
});

export const getCredential = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const credential = await bcpService.getCredentialById(req.params.credentialId);

  if (!credential) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Credential not found' }
    });
  }

  res.json({ success: true, data: credential });
});

export const requestCredentialAccess = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const credential = await bcpService.requestCredentialAccess(
    req.params.credentialId,
    req.body,
    req.user.userId
  );

  res.json({ success: true, data: credential, message: 'Access request submitted' });
});

export const approveCredentialAccess = asyncHandler(async (req, res) => {
  const { requestId, approved, comments } = req.body;

  const bcpService = new BcpService(req.orgId);
  const credential = await bcpService.approveCredentialAccess(
    req.params.credentialId,
    requestId,
    req.user.userId,
    approved,
    comments
  );

  res.json({ success: true, data: credential });
});

export const accessCredential = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const credentials = await bcpService.accessCredential(
    req.params.credentialId,
    req.body.requestId,
    req.user.userId,
    req.ip,
    req.headers['user-agent']
  );

  res.json({ success: true, data: credentials });
});

export const getExpiringCredentials = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const credentials = await bcpService.getExpiringCredentials(parseInt(req.query.days) || 30);

  res.json({ success: true, data: credentials });
});

// ==================== EMERGENCY ACTIVATION ====================

export const triggerEmergency = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }

  const bcpService = new BcpService(req.orgId);
  const emergency = await bcpService.triggerEmergency(req.body, req.user.userId);

  res.status(201).json({ success: true, data: emergency });
});

export const getEmergencies = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const emergencies = await bcpService.getEmergencies(req.query);

  res.json({ success: true, data: emergencies });
});

export const getActiveEmergencies = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const emergencies = await bcpService.getActiveEmergencies();

  res.json({ success: true, data: emergencies });
});

export const getEmergency = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const emergency = await bcpService.getEmergencyById(req.params.emergencyId);

  if (!emergency) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Emergency not found' }
    });
  }

  res.json({ success: true, data: emergency });
});

export const addEmergencyDiscussion = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const emergency = await bcpService.addEmergencyDiscussion(
    req.params.emergencyId,
    req.body.message,
    req.body.attachments,
    req.user.userId
  );

  res.json({ success: true, data: emergency });
});

export const addEmergencyDecision = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const emergency = await bcpService.addEmergencyDecision(
    req.params.emergencyId,
    req.body,
    req.user.userId,
    req.body.role || 'team_member'
  );

  res.json({ success: true, data: emergency });
});

export const escalateEmergencyToTrustees = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const emergency = await bcpService.escalateEmergencyToTrustees(req.params.emergencyId);

  res.json({ success: true, data: emergency });
});

export const addTrusteeEndorsement = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const emergency = await bcpService.addTrusteeEndorsement(
    req.params.emergencyId,
    req.body.endorsement,
    req.body.comments,
    req.user.userId
  );

  res.json({ success: true, data: emergency });
});

export const resolveEmergency = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const emergency = await bcpService.resolveEmergency(
    req.params.emergencyId,
    req.body,
    req.user.userId
  );

  res.json({ success: true, data: emergency });
});

export const closeEmergency = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const emergency = await bcpService.closeEmergency(req.params.emergencyId, req.user.userId);

  res.json({ success: true, data: emergency });
});

// ==================== AUTHORITY TRANSFER ====================

export const createAuthorityTransfer = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'Validation failed', details: errors.array() }
    });
  }

  const bcpService = new BcpService(req.orgId);
  const transfer = await bcpService.createAuthorityTransfer(req.body, req.user.userId);

  res.status(201).json({ success: true, data: transfer });
});

export const getAuthorityTransfers = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const transfers = await bcpService.getAuthorityTransfers(req.query);

  // Resolve person names from board_members
  // (User model fields are encrypted; .lean() skips decryptor getters)
  try {
    const tenantDb = await getTenantConnection(req.orgId);
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (org) {
      const bmRepo = new BoardMemberRepository(tenantDb);
      const boardMembers = await bmRepo.findByOrgId(org._id, true); // includeInactive=true so transferred users still resolve
      const keyHex = getMasterKeyHex();

      // Build user_id → person name map (primary) and position_id → person name map (fallback)
      const userNameMap = new Map();
      const posNameMap = new Map();
      for (const bm of boardMembers) {
        const plain = bm.toObject ? bm.toObject() : { ...bm };
        if (keyHex) decryptBoardMemberFields(plain, keyHex);
        const name = `${plain.given_names || ''} ${plain.family_name || ''}`.trim();
        if (!name) continue;
        if (bm.user_id) userNameMap.set(bm.user_id.toString(), name);
        if (bm.position_id && bm.is_active) posNameMap.set(bm.position_id.toString(), name);
      }

      for (const t of transfers) {
        // Try user_id first (accurate), then fall back to position_id
        const fromUserId = t.from_user_id?._id?.toString() || t.from_user_id?.toString();
        const toUserId = t.to_user_id?._id?.toString() || t.to_user_id?.toString();
        const fromPosId = t.from_position_id?._id?.toString() || t.from_position_id?.toString();
        const toPosId = t.to_position_id?._id?.toString() || t.to_position_id?.toString();
        t.from_person_name = (fromUserId && userNameMap.get(fromUserId)) || posNameMap.get(fromPosId) || null;
        t.to_person_name = (toUserId && userNameMap.get(toUserId)) || posNameMap.get(toPosId) || null;
      }
    }
  } catch (_) {
    // Non-fatal: names will fall back to '—' in the UI
  }

  res.json({ success: true, data: transfers });
});

export const getActiveAuthorityTransfers = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const transfers = await bcpService.getActiveAuthorityTransfers();

  res.json({ success: true, data: transfers });
});

export const getAuthorityTransfer = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const transfer = await bcpService.getAuthorityTransferById(req.params.transferId);

  if (!transfer) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Transfer not found' }
    });
  }

  res.json({ success: true, data: transfer });
});

export const approveAuthorityTransfer = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const transfer = await bcpService.approveAuthorityTransfer(
    req.params.transferId,
    req.body.approved,
    req.body.comments,
    req.user.userId,
    req.body.role || 'manager'
  );

  res.json({ success: true, data: transfer });
});

export const updateAuthorityTransfer = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const transfer = await bcpService.updateAuthorityTransfer(req.params.transferId, req.body);

  res.json({ success: true, data: transfer });
});

export const revokeAuthorityTransfer = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const transfer = await bcpService.revokeAuthorityTransfer(req.params.transferId, req.user.userId);

  res.json({ success: true, data: transfer });
});

export const getExpiringAuthorityTransfers = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const transfers = await bcpService.getExpiringAuthorityTransfers(parseInt(req.query.days) || 14);

  res.json({ success: true, data: transfers });
});

// ==================== DASHBOARD ====================

export const getDashboardStats = asyncHandler(async (req, res) => {
  const bcpService = new BcpService(req.orgId);
  const stats = await bcpService.getDashboardStats();

  res.json({ success: true, data: stats });
});
