/**
 * Board Member Routes
 * 
 * API routes for responsible people (board members)
 */

import express from 'express';
import * as boardMemberController from '../../controllers/boardMemberController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { uploadSingle, handleUploadError } from '../../middleware/upload.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { requireMfa } from '../../middleware/mfa.js';
import { requireAdminOrOwner } from '../../middleware/rbac.js';
import { enforceSeatLimit } from '../../middleware/enforceSeatLimit.js';
import { requireFeatureFlag } from '../../middleware/requireFeatureFlag.js';

const router = express.Router();

// All routes require authentication and tenant resolution
router.use(authAndResolveTenant);
router.use(requireFeatureFlag('governance.organisation'));

// Get departments and roles reference data
router.get('/departments-roles', boardMemberController.getDepartmentsAndRoles);

// Expired IDs — people whose driver's licence or passport has expired
// or will expire within `within` days (default 90). Mounted BEFORE
// `/:boardMemberId` so the literal path wins.
router.get('/expired-ids', boardMemberController.getExpiredIdsList);

// Bulk volunteer import — frontend uploads a parsed array of rows
// (each row already validated client-side; the controller revalidates).
// Per-row creation triggers the same email + policy backfill side
// effects as the single-create flow. Mounted BEFORE the `/:boardMemberId`
// route so the literal path wins.
router.post(
  '/volunteers/bulk-import',
  requireAdminOrOwner,
  [
    body('rows').isArray({ min: 1, max: 500 }).withMessage('rows must be a non-empty array (max 500)')
  ],
  validate,
  boardMemberController.bulkImportVolunteers
);

// Bulk staff/employee import — board_member rows with no discriminator
// flags (regular staff). Email-deduplicated; no invitation email is sent.
// Mounted BEFORE the `/:boardMemberId` route so the literal path wins.
router.post(
  '/employees/bulk-import',
  requireAdminOrOwner,
  [
    body('rows').isArray({ min: 1, max: 500 }).withMessage('rows must be a non-empty array (max 500)')
  ],
  validate,
  boardMemberController.bulkImportEmployees
);

// Create department at runtime (from Add Responsible Person)
router.post(
  '/departments',
  requireAdminOrOwner,
  [
    body('name').trim().notEmpty().withMessage('Department name is required'),
    body('code').optional().trim()
  ],
  validate,
  boardMemberController.createDepartment
);

// Create position/role at runtime (from Add Responsible Person)
router.post(
  '/positions',
  requireAdminOrOwner,
  [
    body('title').trim().notEmpty().withMessage('Position/role title is required'),
    body('department_id').isMongoId().withMessage('Valid department is required'),
    body('granted_permissions').optional().isArray().withMessage('granted_permissions must be an array')
  ],
  validate,
  boardMemberController.createPosition
);

// Update position (e.g. set granted_permissions for training, etc.)
router.put(
  '/positions/:positionId',
  requireAdminOrOwner,
  [
    param('positionId').isMongoId().withMessage('Valid position ID is required'),
    body('granted_permissions').optional().isArray().withMessage('granted_permissions must be an array')
  ],
  validate,
  boardMemberController.updatePosition
);

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

// Suitability checks
router.patch(
  '/:boardMemberId/suitability',
  requireAdminOrOwner,
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  boardMemberController.updateSuitability
);

router.post(
  '/:boardMemberId/suitability/documents',
  requireAdminOrOwner,
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  uploadSingle,
  handleUploadError,
  boardMemberController.uploadSuitabilityDocument
);

router.get(
  '/suitability/bulk-status',
  requireAdminOrOwner,
  boardMemberController.getSuitabilityBulkStatus
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

// Create responsible person (stored in board_members collection)
router.post(
  '/',
  requireAdminOrOwner,
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
      // Volunteers don't need DOB on create — they're just a contact /
      // submission identity. Only board members must supply it.
      .if((value, { req }) => !req.body.is_volunteer)
      .isISO8601()
      .withMessage('Valid date of birth is required')
      .custom((value) => {
        const dob = new Date(value);
        const today = new Date();
        if (dob > today) {
          throw new Error('Date of birth cannot be in the future');
        }
        return true;
      }),
    body('position')
      .if((value, { req }) => !req.body.is_volunteer)
      .trim()
      .notEmpty()
      .withMessage('Position is required'),
    body('appointment_date')
      .if((value, { req }) => !req.body.is_volunteer)
      .notEmpty()
      .withMessage('Appointment date is required')
      .custom((value, { req }) => {
        if (req.body.is_volunteer && !value) return true;
        if (!value) return true;
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          throw new Error('Valid appointment date is required');
        }
        const appointment = date;
        const today = new Date();
        if (appointment > today) {
          throw new Error('Appointment date cannot be in the future');
        }
        if (req.body.date_of_birth) {
          const dob = new Date(req.body.date_of_birth);
          if (appointment <= dob) {
            throw new Error('Appointment date must be after date of birth');
          }
        }
        return true;
      }),
    body('term_end_date')
      .if((value, { req }) => value)
      .custom((value, { req }) => {
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          throw new Error('Valid term end date is required');
        }
        const termEnd = date;
        if (req.body.appointment_date) {
          const appointment = new Date(req.body.appointment_date);
          if (termEnd <= appointment) {
            throw new Error('Term end date must be after appointment date');
          }
        }
        return true;
      }),
    body('email')
      .isEmail()
      .withMessage('Valid email is required'),
    // Residential address is only required for board members. Volunteers
    // can be created with just name + email + phone; they can fill in
    // address later from their own profile if needed.
    body('residential_address.line1')
      .if((value, { req }) => !req.body.is_volunteer)
      .trim()
      .notEmpty()
      .withMessage('Address line 1 is required'),
    body('residential_address.suburb')
      .if((value, { req }) => !req.body.is_volunteer)
      .trim()
      .notEmpty()
      .withMessage('Suburb is required'),
    body('residential_address.state')
      .if((value, { req }) => !req.body.is_volunteer)
      .isIn(['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'])
      .withMessage('Valid state is required'),
    body('residential_address.postcode')
      .if((value, { req }) => !req.body.is_volunteer)
      .trim()
      .notEmpty()
      .withMessage('Postcode is required'),

    // ─── Identification ──────────────────────────────────────────
    // At least one of licence_number OR passport_number is required.
    // The schema's pre('validate') hook is the authoritative check;
    // we mirror it here so callers get a 400 with a friendly message
    // instead of a 500 from the schema validator.
    body('identification').custom((value) => {
      const lic = value?.licence?.number?.trim?.() || '';
      const pas = value?.passport?.number?.trim?.() || '';
      if (!lic && !pas) {
        throw new Error('At least one of driver\'s licence number or passport number is required');
      }
      return true;
    }),
    body('identification.licence.issue_date').optional({ checkFalsy: true }).isISO8601().toDate(),
    body('identification.licence.expiry_date').optional({ checkFalsy: true }).isISO8601().toDate(),
    body('identification.passport.issue_date').optional({ checkFalsy: true }).isISO8601().toDate(),
    body('identification.passport.expiry_date').optional({ checkFalsy: true }).isISO8601().toDate()
  ],
  validate,
  enforceSeatLimit('boardSeats'),
  boardMemberController.createBoardMember
);

// Update board member
router.put(
  '/:boardMemberId',
  requireAdminOrOwner,
  [
    param('boardMemberId')
      .isMongoId()
      .withMessage('Invalid board member ID'),
    // Identification — only validate when the field is being patched.
    // Lets the existing edit flows (name change, role change, etc.)
    // save without touching the ID block. The at-least-one rule still
    // applies when `identification` IS present.
    body('identification').optional().custom((value) => {
      if (!value) return true;
      const lic = value?.licence?.number?.trim?.() || '';
      const pas = value?.passport?.number?.trim?.() || '';
      if (!lic && !pas) {
        throw new Error('At least one of driver\'s licence number or passport number is required');
      }
      return true;
    }),
    body('identification.licence.issue_date').optional({ checkFalsy: true }).isISO8601().toDate(),
    body('identification.licence.expiry_date').optional({ checkFalsy: true }).isISO8601().toDate(),
    body('identification.passport.issue_date').optional({ checkFalsy: true }).isISO8601().toDate(),
    body('identification.passport.expiry_date').optional({ checkFalsy: true }).isISO8601().toDate()
  ],
  validate,
  boardMemberController.updateBoardMember
);

// Delete board member
router.delete(
  '/:boardMemberId',
  requireAdminOrOwner,
  [
    param('boardMemberId')
      .isMongoId()
      .withMessage('Invalid board member ID')
  ],
  validate,
  requireMfa('offboarding_access'),
  boardMemberController.deleteBoardMember
);

// ── WWCC upload / view / delete ──
router.post(
  '/:boardMemberId/wwcc',
  requireAdminOrOwner,
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  uploadSingle,
  handleUploadError,
  boardMemberController.uploadWwcc
);

router.get(
  '/:boardMemberId/wwcc/view',
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  boardMemberController.viewWwcc
);

router.delete(
  '/:boardMemberId/wwcc',
  requireAdminOrOwner,
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  boardMemberController.deleteWwcc
);

// ── Police Check upload / view / delete ──
router.post(
  '/:boardMemberId/police-check',
  requireAdminOrOwner,
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  uploadSingle,
  handleUploadError,
  boardMemberController.uploadPoliceCheck
);

router.get(
  '/:boardMemberId/police-check/view',
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  boardMemberController.viewPoliceCheck
);

router.delete(
  '/:boardMemberId/police-check',
  requireAdminOrOwner,
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  boardMemberController.deletePoliceCheck
);

// ── Contract upload / view / delete ──
router.post(
  '/:boardMemberId/contract',
  requireAdminOrOwner,
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  uploadSingle,
  handleUploadError,
  boardMemberController.uploadContract
);

router.get(
  '/:boardMemberId/contract/view',
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  boardMemberController.viewContract
);

router.delete(
  '/:boardMemberId/contract',
  requireAdminOrOwner,
  [param('boardMemberId').isMongoId().withMessage('Invalid board member ID')],
  validate,
  boardMemberController.deleteContract
);

// ── Directors Handbook upload / view ──
router.post(
  '/directors-handbook',
  requireAdminOrOwner,
  uploadSingle,
  handleUploadError,
  boardMemberController.uploadDirectorsHandbook
);

router.get(
  '/directors-handbook/view',
  boardMemberController.viewDirectorsHandbook
);

export default router;
