/**
 * Calendar Routes
 * 
 * API routes for calendar events
 */

import express from 'express';
import * as calendarController from '../../controllers/calendarController.js';
import { body, param, query } from 'express-validator';
import { validate } from '../../middleware/validation.js';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';

const router = express.Router();

// All routes require authentication and tenant resolution
router.use(authAndResolveTenant);

// Get all calendar events (includes custom, policy expiry, training deadlines)
router.get(
  '/',
  [
    query('start_date')
      .optional()
      .isISO8601()
      .withMessage('start_date must be a valid ISO 8601 date'),
    query('end_date')
      .optional()
      .isISO8601()
      .withMessage('end_date must be a valid ISO 8601 date')
  ],
  validate,
  calendarController.getCalendarEvents
);

// Create custom calendar event
router.post(
  '/',
  [
    body('title')
      .trim()
      .notEmpty()
      .withMessage('Event title is required'),
    body('date')
      .isISO8601()
      .withMessage('Event date must be a valid ISO 8601 date'),
    body('type')
      .optional()
      .isIn(['policy', 'training', 'grant', 'funding', 'compliance', 'meeting', 'custom'])
      .withMessage('Invalid event type'),
    body('description')
      .optional()
      .trim(),
    body('color')
      .optional()
      .trim(),
    body('attendees')
      .optional()
      .isArray()
      .withMessage('attendees must be an array of user IDs'),
    body('attendees.*')
      .optional()
      .isMongoId()
      .withMessage('attendee id must be a valid Mongo ID')
  ],
  validate,
  calendarController.createCustomEvent
);

// Update custom calendar event
router.put(
  '/:id',
  [
    param('id')
      .isMongoId()
      .withMessage('Invalid event ID'),
    body('title')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Event title cannot be empty'),
    body('date')
      .optional()
      .isISO8601()
      .withMessage('Event date must be a valid ISO 8601 date'),
    body('type')
      .optional()
      .isIn(['policy', 'training', 'grant', 'funding', 'compliance', 'meeting', 'custom'])
      .withMessage('Invalid event type'),
    body('description')
      .optional()
      .trim(),
    body('color')
      .optional()
      .trim(),
    body('attendees')
      .optional()
      .isArray()
      .withMessage('attendees must be an array of user IDs'),
    body('attendees.*')
      .optional()
      .isMongoId()
      .withMessage('attendee id must be a valid Mongo ID'),
    body('completed')
      .optional()
      .isBoolean()
      .withMessage('completed must be true or false')
  ],
  validate,
  calendarController.updateCustomEvent
);

// Delete custom calendar event
router.delete(
  '/:id',
  [
    param('id')
      .isMongoId()
      .withMessage('Invalid event ID')
  ],
  validate,
  calendarController.deleteCustomEvent
);

export default router;
