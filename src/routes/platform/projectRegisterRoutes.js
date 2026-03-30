/**
 * Project Register Routes
 */

import express from 'express';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import * as projectRegisterController from '../../controllers/projectRegisterController.js';

const router = express.Router();

router.use(authAndResolveTenant);

router.get('/counts', projectRegisterController.getProjectCounts);

router.post(
  '/',
  [
    body('project_name').trim().notEmpty().withMessage('Project name is required'),
    body('agreement_title').optional().trim(),
    body('planned_start_date').optional().isISO8601().toDate(),
    body('planned_end_date').optional().isISO8601().toDate(),
    body('status').optional().isIn(['active', 'pending', 'at_risk', 'completed'])
  ],
  validate,
  projectRegisterController.createProject
);

router.get(
  '/',
  [
    query('status').optional().isIn(['active', 'pending', 'at_risk', 'completed']),
    query('search').optional().trim()
  ],
  validate,
  projectRegisterController.getProjects
);

router.get(
  '/:projectId',
  [param('projectId').isMongoId().withMessage('Invalid project ID')],
  validate,
  projectRegisterController.getProjectById
);

router.patch(
  '/:projectId',
  [
    param('projectId').isMongoId().withMessage('Invalid project ID'),
    body('project_name').optional().trim().notEmpty().withMessage('Project name cannot be empty'),
    body('description').optional().isString(),
    body('planned_start_date').optional({ nullable: true }).isISO8601().toDate(),
    body('planned_end_date').optional({ nullable: true }).isISO8601().toDate(),
    body('status').optional().isIn(['active', 'pending', 'at_risk', 'completed']),
    body('phase').optional().isString(),
    body('warning').optional().isString(),
    body('metadata').optional().isObject()
  ],
  validate,
  projectRegisterController.updateProject
);

export default router;
