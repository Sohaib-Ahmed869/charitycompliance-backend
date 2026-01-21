/**
 * Validation Middleware
 * 
 * Handles express-validator validation results
 */

import { validationResult } from 'express-validator';
import { AppError } from './errorHandler.js';

export const validate = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(err => ({
      field: err.path || err.param,
      message: err.msg
    }));

    throw new AppError('Validation failed', 400, 'VALIDATION_ERROR', errorMessages);
  }

  next();
};
