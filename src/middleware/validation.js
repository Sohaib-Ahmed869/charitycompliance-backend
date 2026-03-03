/**
 * Validation Middleware
 * 
 * Handles express-validator validation results
 */

import { validationResult } from 'express-validator';
import { AppError } from './errorHandler.js';
import { logError } from '../utils/logger.js';

export const validate = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(err => ({
      field: err.path || err.param,
      message: err.msg,
      value: err.value
    }));

    logError('Validation failed', new Error('Validation failed'), {
      path: req.path,
      method: req.method,
      fields: errorMessages.map(e => `${e.field}: ${e.message} (got: ${JSON.stringify(e.value)})`)
    });

    const details = errorMessages.map(e => ({ field: e.field, message: e.message }));
    throw new AppError('Validation failed', 400, 'VALIDATION_ERROR', details);
  }

  next();
};
