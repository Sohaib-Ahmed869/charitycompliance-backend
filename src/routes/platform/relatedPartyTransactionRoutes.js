/**
 * Related Party Transaction (RPT) Register routes.
 * Mounted at /api/v1/platform/related-party-transactions.
 *
 * Gated by the governance.organisation feature flag (Foundation+, i.e. all
 * tiers) so RPT is available to every plan, matching COI.
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';
import { validate } from '../../middleware/validation.js';
import * as rpt from '../../controllers/relatedPartyTransactionController.js';

const router = express.Router();
router.use(authAndResolveTenant);
router.use(requireFeatureFlag('governance.organisation'));

router.get(
  '/',
  [
    query('status').optional().isString(),
    query('riskLevel').optional().isIn(['low', 'medium', 'high']),
    query('search').optional().isString()
  ],
  validate,
  rpt.listRpts
);

router.get('/counts', rpt.getRptCounts);

router.get('/by-coi/:coiRequestId', [param('coiRequestId').isMongoId()], validate, rpt.getRptByCoi);

router.post(
  '/',
  [
    body('related_party_name').trim().notEmpty().withMessage('Related party name is required'),
    body('transaction_description').trim().notEmpty().withMessage('Transaction description is required'),
    body('relationship_type').optional().isString(),
    body('transaction_value').optional({ nullable: true })
  ],
  validate,
  rpt.createRpt
);

// AI/keyword detection of RPT likelihood from a COI declaration.
router.post(
  '/detect',
  [
    body('reason').optional().isString(),
    body('personName').optional().isString(),
    body('personDetails').optional().isString(),
  ],
  validate,
  rpt.detectRpt
);

// Live risk preview (no persistence) — powers the score read-out in the form.
router.post(
  '/assess',
  [
    body('relationship_type').optional().isString(),
    body('transaction_value').optional({ nullable: true })
  ],
  validate,
  rpt.previewRptRisk
);

router.get('/:rptId', [param('rptId').isMongoId()], validate, rpt.getRpt);
router.put('/:rptId', [param('rptId').isMongoId()], validate, rpt.updateRpt);
router.delete('/:rptId', [param('rptId').isMongoId()], validate, rpt.deleteRpt);

// Link an existing RPT to a COI declaration (counterpart of create-from-COI).
router.post('/:rptId/link-to-coi', [param('rptId').isMongoId(), body('coi_request_id').isMongoId()], validate, rpt.linkRptToCoi);

router.post('/:rptId/board-decision', [param('rptId').isMongoId()], validate, rpt.recordBoardDecision);
router.post('/:rptId/status', [param('rptId').isMongoId(), body('status').isString()], validate, rpt.updateRptStatus);
router.post('/:rptId/documents', [param('rptId').isMongoId(), body('file_key').notEmpty()], validate, rpt.addRptDocument);

export default router;
