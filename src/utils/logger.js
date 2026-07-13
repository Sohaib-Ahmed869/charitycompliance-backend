/**
 * Logger Utility
 * 
 * Centralized logging with levels and structured output.
 * Replaces console.log for production-ready logging.
 */

import fs from 'node:fs';
import path from 'node:path';

const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

// LOG-004: optional durable file sink. When LOG_FILE is set the formatted line
// is appended to that file (in addition to console) so logs survive process
// restarts and can be shipped by a log agent. Best-effort — must NEVER affect
// the application: the parent dir is created if missing, an async 'error'
// handler is attached (an unhandled stream error would otherwise crash the
// process), and any failure permanently disables the sink.
const LOG_FILE_PATH = (process.env.LOG_FILE || '').trim();
let logFileStream = null;
let sinkDisabled = false;
const writeToSink = (line) => {
  if (!LOG_FILE_PATH || sinkDisabled) return;
  try {
    if (!logFileStream) {
      const dir = path.dirname(LOG_FILE_PATH);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      logFileStream = fs.createWriteStream(LOG_FILE_PATH, { flags: 'a' });
      // Without this handler a runtime write/open error is emitted as an
      // unhandled 'error' event and takes the whole process down.
      logFileStream.on('error', () => {
        sinkDisabled = true;
        logFileStream = null;
      });
    }
    logFileStream.write(line + '\n');
  } catch {
    // mkdir/open failed synchronously — disable and fall back to console only.
    sinkDisabled = true;
    logFileStream = null;
  }
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
    const line = formatMessage('ERROR', message, errorContext);
    console.error(line);
    writeToSink(line);
  }
};

/**
 * Log warning
 */
export const logWarn = (message, context = {}) => {
  if (levelValue >= LOG_LEVELS.WARN) {
    const line = formatMessage('WARN', message, context);
    console.warn(line);
    writeToSink(line);
  }
};

/**
 * Log info (important business events only)
 */
export const logInfo = (message, context = {}) => {
  if (levelValue >= LOG_LEVELS.INFO) {
    const line = formatMessage('INFO', message, context);
    console.log(line);
    writeToSink(line);
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
