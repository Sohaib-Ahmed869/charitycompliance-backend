/**
 * Logger Utility
 * 
 * Centralized logging with levels and structured output.
 * Replaces console.log for production-ready logging.
 */

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

const currentLogLevel = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'INFO' : 'DEBUG');
const levelValue = LOG_LEVELS[currentLogLevel.toUpperCase()] ?? LOG_LEVELS.INFO;

/**
 * Format log message with timestamp and context
 */
const formatMessage = (level, message, context = {}) => {
  const timestamp = new Date().toISOString();
  const contextStr = Object.keys(context).length > 0 ? JSON.stringify(context) : '';
  return `${timestamp} ${level} ${message}${contextStr ? ' ' + contextStr : ''}`;
};

/**
 * Log error with stack trace
 */
export const logError = (message, error, context = {}) => {
  if (levelValue >= LOG_LEVELS.ERROR) {
    const errorContext = {
      ...context,
      error: {
        message: error?.message || message,
        stack: process.env.NODE_ENV === 'development' ? error?.stack : undefined,
        name: error?.name
      }
    };
    console.error(formatMessage('ERROR', message, errorContext));
  }
};

/**
 * Log warning
 */
export const logWarn = (message, context = {}) => {
  if (levelValue >= LOG_LEVELS.WARN) {
    console.warn(formatMessage('WARN', message, context));
  }
};

/**
 * Log info (important business events only)
 */
export const logInfo = (message, context = {}) => {
  if (levelValue >= LOG_LEVELS.INFO) {
    console.log(formatMessage('INFO', message, context));
  }
};

/**
 * Log debug (development only)
 */
export const logDebug = (message, context = {}) => {
  if (levelValue >= LOG_LEVELS.DEBUG && process.env.NODE_ENV !== 'production') {
    console.log(formatMessage('DEBUG', message, context));
  }
};

/**
 * Main logger function
 * Usage: logger('error', 'message', { context })
 */
const logger = (level, message, context = {}) => {
  switch (level.toLowerCase()) {
    case 'error':
      logError(message, context.error || new Error(message), context);
      break;
    case 'warn':
      logWarn(message, context);
      break;
    case 'info':
      logInfo(message, context);
      break;
    case 'debug':
      logDebug(message, context);
      break;
    default:
      logInfo(message, context);
  }
};

export default logger;
