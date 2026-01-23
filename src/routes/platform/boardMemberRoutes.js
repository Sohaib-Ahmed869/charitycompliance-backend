/**
 * Board Member Routes
 * 
 * API routes for responsible people (board members)
 */

import express from 'express';
import * as boardMemberController from '../../controllers/boardMemberController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// All routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Get all board members
router.get(
  '/',
  [
    query('includeInactive')
      .optional()
      .isBoolean()
      .withMessage('includeInactive must be a boolean')
  ],
  validate,
  boardMemberController.getBoardMembers
);

// Get board member by ID
router.get(
  '/:boardMemberId',
  [
    param('boardMemberId')
      .isMongoId()
      .withMessage('Invalid board member ID')
  ],
  validate,
  boardMemberController.getBoardMemberById
);

// Create board member
router.post(
  '/',
  [
    body('given_names')
      .trim()
      .notEmpty()
      .withMessage('Given names are required'),
    body('family_name')
      .trim()
      .notEmpty()
      .withMessage('Family name is required'),
    body('date_of_birth')
      .isISO8601()
      .withMessage('Valid date of birth is required'),
    body('position')
      .isIn(['Chair', 'Deputy Chair', 'Treasurer', 'Secretary', 'Director', 'Trustee', 'Committee Member', 'Public Officer', 'Other'])
      .withMessage('Invalid position'),
    body('appointment_date')
      .isISO8601()
      .withMessage('Valid appointment date is required'),
    body('email')
      .isEmail()
      .withMessage('Valid email is required'),
    body('residential_address.line1')
      .trim()
      .notEmpty()
      .withMessage('Address line 1 is required'),
    body('residential_address.suburb')
      .trim()
      .notEmpty()
      .withMessage('Suburb is required'),
    body('residential_address.state')
      .isIn(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'])
      .withMessage('Valid state is required'),
    body('residential_address.postcode')
      .trim()
      .notEmpty()
      .withMessage('Postcode is required')
  ],
  validate,
  boardMemberController.createBoardMember
);

// Update board member
router.put(
  '/:boardMemberId',
  [
    param('boardMemberId')
      .isMongoId()
      .withMessage('Invalid board member ID')
  ],
  validate,
  boardMemberController.updateBoardMember
);

// Delete board member
router.delete(
  '/:boardMemberId',
  [
    param('boardMemberId')
      .isMongoId()
      .withMessage('Invalid board member ID')
  ],
  validate,
  boardMemberController.deleteBoardMember
);

export default router;
