/**
 * Approval Routes
 * 
 * API routes for approval workflows
 */

import express from 'express';
import * as approvalController from '../../controllers/approvalController.js';
import { body, param } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { uploadAcknowledgementFiles, handleUploadError } from '../../middleware/upload.js';
import { asyncHandler, AppError } from '../../middleware/errorHandler.js';
import mongoose from 'mongoose';
import { ApprovalRequestRepository } from '../../repositories/approvalRequestRepository.js';
import { streamApprovalsZip } from '../../services/approvalZipExportService.js';

const router = express.Router();

// All approval routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Pre-flight: check whether a workflow is configured for a given category/actionType.
// FE calls this before opening any module's "create" form so it can surface a
// helpful redirect dialog instead of letting the user fill a form that will fail.
router.get('/precheck', approvalController.precheckWorkflow);

// Get approval matrices (workflows)
router.get('/matrices', approvalController.getApprovalMatrices);

// Create approval matrix (workflow)
router.post(
  '/matrices',
  [
    body('name')
      .trim()
      .notEmpty()
      .withMessage('Workflow name is required'),
    body('action_type')
      .trim()
      .notEmpty()
      .withMessage('Workflow type is required'),
    body('priority')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Priority must be a non-negative integer'),
    body('priority_level')
      .optional()
      .isIn(['high', 'medium', 'low'])
      .withMessage('Priority level must be high, medium, or low'),
    body('description')
      .optional()
      .trim(),
    body('positions')
      .optional()
      .isArray()
      .withMessage('Positions must be an array'),
    body('effective_from')
      .optional({ nullable: true })
      .isISO8601()
      .withMessage('effective_from must be a valid ISO 8601 date'),
    body('effective_to')
      .optional({ nullable: true })
      .isISO8601()
      .withMessage('effective_to must be a valid ISO 8601 date')
  ],
  validate,
  approvalController.createApprovalMatrix
);

// Update approval matrix (workflow)
router.put(
  '/matrices/:matrixId',
  [
    param('matrixId')
      .isMongoId()
      .withMessage('Invalid matrix ID'),
    body('name')
      .optional()
      .trim(),
    body('description')
      .optional()
      .trim(),
    body('priority')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Priority must be a non-negative integer'),
    body('priority_level')
      .optional()
      .isIn(['high', 'medium', 'low'])
      .withMessage('Priority level must be high, medium, or low'),
    body('positions')
      .optional()
      .isArray()
      .withMessage('Positions must be an array'),
    body('effective_from')
      .optional({ nullable: true })
      .isISO8601()
      .withMessage('effective_from must be a valid ISO 8601 date'),
    body('effective_to')
      .optional({ nullable: true })
      .isISO8601()
      .withMessage('effective_to must be a valid ISO 8601 date')
  ],
  validate,
  approvalController.updateApprovalMatrix
);

// Revoke approval matrix (workflow)
router.post(
  '/matrices/:matrixId/revoke',
  [
    param('matrixId')
      .isMongoId()
      .withMessage('Invalid matrix ID')
  ],
  validate,
  approvalController.revokeApprovalMatrix
);

// List all approval requests for the org (optional status filter)
router.get('/list', approvalController.listApprovalRequests);

/**
 * POST /approvals/export-zip
 *
 * Audit-pack export. The frontend already knows which workflows match
 * the user's filter view, so it passes the resulting approval_ids
 * verbatim. The backend re-loads those (with org-scope safety) and
 * streams a ZIP via approvalZipExportService.
 *
 * Body:
 *   approval_ids: string[]                  required, MongoIds
 *   filters?: object                        describes the filter set,
 *                                           embedded in the README for
 *                                           reproducibility
 */
router.post(
  '/export-zip',
  [
    body('approval_ids').isArray({ min: 1, max: 5000 }),
    body('approval_ids.*').isMongoId()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const orgId = req.orgId;
    const tenantDb = req.tenantDb;
    if (!tenantDb) throw new AppError('Tenant DB not resolved', 500, 'TENANT_DB_MISSING');

    // Building the repository registers ApprovalRequest + Position +
    // Department + ApprovalMatrix + User on this tenant connection.
    // Without that the populate chain below errors out with a
    // MissingSchemaError on whichever ref hits Mongoose first.
    const approvalRequestRepo = new ApprovalRequestRepository(tenantDb);
    const ApprovalRequest = approvalRequestRepo.ApprovalRequest;

    const ids = req.body.approval_ids.map((id) => new mongoose.Types.ObjectId(id));

    // Resolve the org's _id once — the schema stores org_id as the
    // Mongo _id of the Organization, not the string orgId.
    const { OrganizationRepository } = await import('../../repositories/organizationRepository.js');
    const orgRepo = new OrganizationRepository(tenantDb);
    const org = await orgRepo.findOne();
    if (!org) throw new AppError('Organisation not found', 404, 'ORG_NOT_FOUND');

    // Fetch the full docs with the populates the exporter needs.
    const approvals = await ApprovalRequest.find({
      _id: { $in: ids },
      org_id: org._id
    })
      .populate('submitted_by', 'first_name last_name email')
      .populate('approval_matrix_id', 'name')
      // Field is `approval_steps`, not `steps` — matches the schema.
      .populate('approval_steps.approver_user_id', 'first_name last_name email')
      .populate('approval_steps.approver_position_id', 'name title')
      .populate('approval_steps.approver_department_id', 'name')
      .populate('rejection_reviews.rejected_by', 'first_name last_name email')
      .populate('rejection_reviews.forwarded_to', 'first_name last_name email')
      .populate('escalations.escalated_by', 'first_name last_name email')
      .populate('escalations.escalated_to', 'first_name last_name email')
      .sort({ created_at: -1 })
      .lean();

    if (!approvals.length) {
      return res.status(404).json({
        success: false,
        error: { code: 'NO_WORKFLOWS', message: 'No matching workflows found for this organisation.' }
      });
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `approval-workflows-${orgId}-${dateStr}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    await streamApprovalsZip(approvals, res, {
      orgId,
      filters: req.body.filters || {},
      orgLogoUrl: org.logo_url || ''
    });
  })
);

// Update workflow positions for an action type
router.put(
  '/workflows/:actionType',
  [
    body('positions')
      .isArray()
      .withMessage('positions must be an array'),
    body('positions.*')
      .custom((pos) => (pos.positionId || pos.id) && typeof (pos.positionId || pos.id) === 'string')
      .withMessage('Each position must have positionId or id'),
    body('positions.*.approvalLevel')
      .optional()
      .isInt({ min: 1 })
      .withMessage('approvalLevel must be a positive integer')
  ],
  validate,
  approvalController.updateWorkflowPositions
);

// Get pending approvals for current user
router.get('/pending', approvalController.getPendingApprovals);

// Get in-flight approval request(s) for a specific entity — powers the
// "routed for approval to X" banner on entity detail pages. Must stay
// above the /:approvalRequestId route so "by-entity" isn't read as an id.
router.get('/by-entity', approvalController.getApprovalRequestsByEntity);

// Get approval request by ID
router.get(
  '/:approvalRequestId',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID')
  ],
  validate,
  approvalController.getApprovalRequestById
);

// Download approval workflow PDF
router.get(
  '/:approvalRequestId/download-pdf',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID')
  ],
  validate,
  approvalController.downloadApprovalPDF
);

// Upload acknowledgement files
router.post(
  '/upload-acknowledgement',
  uploadAcknowledgementFiles,
  handleUploadError,
  approvalController.uploadAcknowledgementFiles
);

// Approve request
router.post(
  '/:approvalRequestId/approve',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('stepIndex')
      .isInt({ min: 0 })
      .withMessage('Step index must be a non-negative integer'),
    body('comments')
      .optional()
      .trim(),
    // null is sent from JSON when absent on non-final steps — treat as omitted (optional() only skips undefined by default)
    body('e_signature')
      .optional({ nullable: true })
      .isString()
      .withMessage('e_signature must be a string data URL when provided')
  ],
  validate,
  approvalController.approveRequest
);

// Approve risk with likelihood and severity (department head only)
// This endpoint is called when the department head approves a risk
// and selects likelihood/severity, which auto-calculates priority and determines the workflow
router.post(
  '/:approvalRequestId/approve-with-priority',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('likelihood')
      .isInt({ min: 1, max: 5 })
      .withMessage('Likelihood must be between 1 and 5'),
    body('severity')
      .isInt({ min: 1, max: 5 })
      .withMessage('Severity must be between 1 and 5'),
    body('comments')
      .optional()
      .trim(),
    body('e_signature')
      .optional({ nullable: true })
      .isString()
      .withMessage('e_signature must be a string data URL when provided')
  ],
  validate,
  approvalController.approveRiskWithPriority
);

// Reject request
router.post(
  '/:approvalRequestId/reject',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('stepIndex')
      .isInt({ min: 0 })
      .withMessage('Step index must be a non-negative integer'),
    body('comments')
      .trim()
      .notEmpty()
      .withMessage('Rejection reason is required')
  ],
  validate,
  approvalController.rejectRequest
);

// Submit COI request (pauses main workflow)
router.post(
  '/:approvalRequestId/coi',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('reason')
      .trim()
      .notEmpty()
      .withMessage('COI reason is required')
  ],
  validate,
  approvalController.submitCoiRequest
);

// Rejection Workflow Routes

// Get pending rejection reviews for current user
router.get('/rejection-reviews/pending', approvalController.getPendingRejectionReviews);

// Get workflow participants (for rejection forwarding)
router.get(
  '/:approvalRequestId/participants',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID')
  ],
  validate,
  approvalController.getWorkflowParticipants
);

// Forward rejection for review
router.post(
  '/:approvalRequestId/forward-rejection',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('stepIndex')
      .isInt({ min: 0 })
      .withMessage('Step index must be a non-negative integer'),
    body('forwardToUserId')
      .isMongoId()
      .withMessage('Valid forward to user ID is required'),
    body('rejectionComments')
      .trim()
      .notEmpty()
      .withMessage('Rejection reason is required')
  ],
  validate,
  approvalController.forwardRejection
);

// Resubmit approval (submitter re-runs workflow after decline upheld)
router.post(
  '/:approvalRequestId/resubmit',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID')
  ],
  validate,
  approvalController.resubmitApproval
);

// Review rejection (accept or reject the rejection)
router.post(
  '/:approvalRequestId/review-rejection',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('reviewAction')
      .trim()
      .notEmpty()
      .withMessage('Review action is required')
      .isIn(['accept_rejection', 'reject_rejection'])
      .withMessage('Review action must be accept_rejection or reject_rejection'),
    body('reviewComments')
      .trim()
      .notEmpty()
      .withMessage('Review comments are required')
  ],
  validate,
  approvalController.reviewRejection
);

// Escalate to another user for opinion (does not change approver)
router.post(
  '/:approvalRequestId/escalate',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    body('stepIndex')
      .isInt({ min: 0 })
      .withMessage('Step index must be a non-negative integer'),
    body('escalateToUserId')
      .isMongoId()
      .withMessage('Valid escalate-to user ID is required'),
    body('comments')
      .trim()
      .notEmpty()
      .withMessage('Comments are required')
  ],
  validate,
  approvalController.escalateForOpinion
);

// Respond to an escalation request
router.post(
  '/:approvalRequestId/escalations/:escalationId/respond',
  [
    param('approvalRequestId')
      .isMongoId()
      .withMessage('Invalid approval request ID'),
    param('escalationId')
      .isMongoId()
      .withMessage('Invalid escalation ID'),
    body('comments')
      .trim()
      .notEmpty()
      .withMessage('Comments are required')
  ],
  validate,
  approvalController.respondToEscalation
);

export default router;
