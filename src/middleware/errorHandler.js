/**
 * Error Handler Middleware
 * 
 * Centralized error handling for Express application.
 * Catches all errors and returns consistent error responses.
 */

import { logError } from '../utils/logger.js';

/**
 * Custom Error Class
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, code = null, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Error Handler Middleware
 * Must be the last middleware in the stack
 */
export const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;
  error.statusCode = err.statusCode || 500;

  const errorContext = {
    statusCode: error.statusCode,
    path: req.path,
    method: req.method,
    orgId: req.orgId,
    userId: req.user?.userId,
    code: error.code
  };

  logError('Request error', err, errorContext);

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    const message = 'Resource not found';
    error = new AppError(message, 404, 'INVALID_ID');
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const keyPattern = err.keyPattern || {};
    const keyValue = err.keyValue || {};
    
    // Handle department duplicate errors specifically
    if (keyPattern.org_id && keyPattern.code) {
      const code = keyValue.code || 'this code';
      const message = `A department with code "${code}" already exists. Please use a different code.`;
      error = new AppError(message, 400, 'DUPLICATE_DEPARTMENT_CODE');
    } else if (keyPattern.org_id && keyPattern.name) {
      const name = keyValue.name || 'this name';
      const message = `A department with name "${name}" already exists. Please use a different name.`;
      error = new AppError(message, 400, 'DUPLICATE_DEPARTMENT_NAME');
    } else {
      // Generic duplicate key error
      const field = Object.keys(keyPattern)[0] || 'field';
      const message = `${field} already exists`;
      error = new AppError(message, 400, 'DUPLICATE_KEY');
    }
    
    // Add details about which field caused the duplicate
    error.details = {
      duplicateFields: Object.keys(keyPattern),
      duplicateValues: keyValue
    };
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map(e => e.message);
    const message = messages.join(', ');
    error = new AppError(message, 400, 'VALIDATION_ERROR');
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    error = new AppError('Invalid token', 401, 'INVALID_TOKEN');
  }

  if (err.name === 'TokenExpiredError') {
    error = new AppError('Token expired', 401, 'TOKEN_EXPIRED');
  }

  // Encryption errors
  if (err.message && err.message.includes('Decryption failed')) {
    error = new AppError('Data decryption failed', 500, 'DECRYPTION_ERROR');
  }

  // Body parser (payload too large)
  if (err.type === 'entity.too.large' || err.status === 413) {
    error = new AppError(
      'Payload too large. Please upload smaller files or reduce attachments.',
      413,
      'PAYLOAD_TOO_LARGE'
    );
  }

  // Send error response
  const response = {
    success: false,
    error: {
      message: error.message || 'Internal server error',
      code: error.code || 'INTERNAL_ERROR'
    }
  };

  if (error.details) {
    response.error.details = error.details;
  }

  if (process.env.NODE_ENV === 'development' && err.stack) {
    response.error.stack = err.stack;
  }

  res.status(error.statusCode || 500).json(response);
};

/**
 * 404 Not Found Handler
 * Must be placed after all routes
 */
export const notFoundHandler = (req, res, next) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.originalUrl} not found`,
    code: 'NOT_FOUND'
  });
};

/**
 * Async Handler Wrapper
 * Wraps async route handlers to catch errors automatically
 * 
 * @param {Function} fn - Async route handler
 * @returns {Function} Wrapped handler
 */
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

export default {
  errorHandler,
  notFoundHandler,
  asyncHandler,
  AppError
};
