/**
 * BCP Routes
 * 
 * API routes for Business Continuity Plan module
 */

import express from 'express';
import { body, param } from 'express-validator';
import * as bcpController from '../../controllers/bcpController.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// Apply authentication and tenant resolution to all routes
router.use(authAndResolveTenant);

// ==================== DASHBOARD ====================
router.get('/dashboard/stats', bcpController.getDashboardStats);

// ==================== EMERGENCY TEAMS ====================
router.post('/teams',
  body('team_name').notEmpty().withMessage('Team name is required'),
  body('members').isArray().withMessage('Members must be an array'),
  bcpController.createEmergencyTeam
);

router.get('/teams', bcpController.getEmergencyTeams);

router.get('/teams/:teamId',
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  bcpController.getEmergencyTeam
);

router.put('/teams/:teamId',
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  bcpController.updateEmergencyTeam
);

router.delete('/teams/:teamId',
  param('teamId').isMongoId().withMessage('Invalid team ID'),
  bcpController.deleteEmergencyTeam
);

// ==================== RISKS ====================
router.post('/risks',
  body('category').isIn(['financial', 'it_technology', 'legal_compliance', 'key_personnel']).withMessage('Invalid category'),
  body('title').notEmpty().withMessage('Title is required'),
  body('description').notEmpty().withMessage('Description is required'),
  body('impact_level').isIn(['low', 'medium', 'high', 'critical']).withMessage('Invalid impact level'),
  body('likelihood').isIn(['rare', 'unlikely', 'possible', 'likely', 'almost_certain']).withMessage('Invalid likelihood'),
  bcpController.createRisk
);

router.get('/risks', bcpController.getRisks);
router.get('/risks/stats', bcpController.getRiskStats);
router.get('/risks/due-review', bcpController.getRisksDueForReview);

router.get('/risks/:riskId',
  param('riskId').isMongoId().withMessage('Invalid risk ID'),
  bcpController.getRisk
);

router.put('/risks/:riskId',
  param('riskId').isMongoId().withMessage('Invalid risk ID'),
  bcpController.updateRisk
);

router.post('/risks/:riskId/escalate',
  param('riskId').isMongoId().withMessage('Invalid risk ID'),
  body('escalated_to').isIn(['team_lead', 'emergency_team', 'trustee']).withMessage('Invalid escalation target'),
  body('reason').notEmpty().withMessage('Reason is required'),
  bcpController.escalateRisk
);

// ==================== CREDENTIAL VAULT ====================
router.post('/credentials',
  body('category').isIn(['banking', 'hosting', 'domain', 'social_media', 'regulatory', 'subscription', 'legal', 'insurance', 'other']).withMessage('Invalid category'),
  body('name').notEmpty().withMessage('Name is required'),
  body('owner_position_id').isMongoId().withMessage('Owner position is required'),
  bcpController.createCredential
);

router.get('/credentials', bcpController.getCredentials);
router.get('/credentials/expiring', bcpController.getExpiringCredentials);

router.get('/credentials/:credentialId',
  param('credentialId').isMongoId().withMessage('Invalid credential ID'),
  bcpController.getCredential
);

router.post('/credentials/:credentialId/request-access',
  param('credentialId').isMongoId().withMessage('Invalid credential ID'),
  body('reason').notEmpty().withMessage('Reason is required'),
  bcpController.requestCredentialAccess
);

router.post('/credentials/:credentialId/approve-access',
  param('credentialId').isMongoId().withMessage('Invalid credential ID'),
  body('requestId').isMongoId().withMessage('Request ID is required'),
  body('approved').isBoolean().withMessage('Approval decision is required'),
  bcpController.approveCredentialAccess
);

router.post('/credentials/:credentialId/access',
  param('credentialId').isMongoId().withMessage('Invalid credential ID'),
  body('requestId').isMongoId().withMessage('Request ID is required'),
  bcpController.accessCredential
);

// ==================== EMERGENCY ACTIVATION ====================
router.post('/emergencies',
  body('title').notEmpty().withMessage('Title is required'),
  body('description').notEmpty().withMessage('Description is required'),
  body('category').isIn(['financial', 'it_technology', 'legal_compliance', 'key_personnel', 'natural_disaster', 'security_breach', 'other']).withMessage('Invalid category'),
  body('severity').isIn(['minor', 'moderate', 'major', 'critical']).withMessage('Invalid severity'),
  bcpController.triggerEmergency
);

router.get('/emergencies', bcpController.getEmergencies);
router.get('/emergencies/active', bcpController.getActiveEmergencies);

router.get('/emergencies/:emergencyId',
  param('emergencyId').isMongoId().withMessage('Invalid emergency ID'),
  bcpController.getEmergency
);

router.post('/emergencies/:emergencyId/discussion',
  param('emergencyId').isMongoId().withMessage('Invalid emergency ID'),
  body('message').notEmpty().withMessage('Message is required'),
  bcpController.addEmergencyDiscussion
);

router.post('/emergencies/:emergencyId/decision',
  param('emergencyId').isMongoId().withMessage('Invalid emergency ID'),
  body('decision').notEmpty().withMessage('Decision is required'),
  bcpController.addEmergencyDecision
);

router.post('/emergencies/:emergencyId/escalate',
  param('emergencyId').isMongoId().withMessage('Invalid emergency ID'),
  bcpController.escalateEmergencyToTrustees
);

router.post('/emergencies/:emergencyId/endorsement',
  param('emergencyId').isMongoId().withMessage('Invalid emergency ID'),
  body('endorsement').isIn(['approved', 'rejected', 'requires_modification']).withMessage('Invalid endorsement'),
  bcpController.addTrusteeEndorsement
);

router.post('/emergencies/:emergencyId/resolve',
  param('emergencyId').isMongoId().withMessage('Invalid emergency ID'),
  body('summary').notEmpty().withMessage('Resolution summary is required'),
  bcpController.resolveEmergency
);

router.post('/emergencies/:emergencyId/close',
  param('emergencyId').isMongoId().withMessage('Invalid emergency ID'),
  bcpController.closeEmergency
);

// ==================== AUTHORITY TRANSFER ====================
router.post('/transfers',
  body('from_position_id').isMongoId().withMessage('From position is required'),
  body('from_department_id').isMongoId().withMessage('From department is required'),
  body('to_position_id').isMongoId().withMessage('To position is required'),
  body('to_department_id').isMongoId().withMessage('To department is required'),
  body('transfer_type').isIn(['temporary', 'permanent', 'emergency']).withMessage('Invalid transfer type'),
  body('reason').isIn(['leave', 'resignation', 'termination', 'illness', 'emergency', 'restructure', 'other']).withMessage('Invalid reason'),
  body('effective_date').isISO8601().withMessage('Valid effective date is required'),
  bcpController.createAuthorityTransfer
);

router.get('/transfers', bcpController.getAuthorityTransfers);
router.get('/transfers/active', bcpController.getActiveAuthorityTransfers);
router.get('/transfers/expiring', bcpController.getExpiringAuthorityTransfers);

router.get('/transfers/:transferId',
  param('transferId').isMongoId().withMessage('Invalid transfer ID'),
  bcpController.getAuthorityTransfer
);

router.put('/transfers/:transferId',
  param('transferId').isMongoId().withMessage('Invalid transfer ID'),
  bcpController.updateAuthorityTransfer
);

router.post('/transfers/:transferId/approve',
  param('transferId').isMongoId().withMessage('Invalid transfer ID'),
  body('approved').isBoolean().withMessage('Approval decision is required'),
  bcpController.approveAuthorityTransfer
);

export default router;
