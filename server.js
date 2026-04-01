/**
 * Server Entry Point
 * 
 * Starts the Express server and handles graceful shutdown.
 */

import app, { initializeApp } from './src/app.js';
import dotenv from 'dotenv';
import { closeRouterDB } from './src/config/database.js';
import { closeAllConnections } from './src/db/connectionManager.js';
import emailService from './src/services/emailService.js';
import { logError, logInfo, logWarn } from './src/utils/logger.js';
import { startRegistrationLicenseReminderScheduler } from './src/services/registrationLicenseReminderService.js';
import { startMeetingReminderScheduler } from './src/services/meetingReminderService.js';
import { runRegistrationLicenseRemindersOnce } from './src/services/registrationLicenseReminderService.js';
import { runMeetingRemindersOnce } from './src/services/meetingReminderService.js';

dotenv.config();

const PORT = process.env.PORT || 5000;

// Initialize and start server
const startServer = async () => {
  try {
    // Initialize application (connect to Router DB, etc.)
    await initializeApp();

    const server = app.listen(PORT, () => {
      logInfo('Server started', { port: PORT, environment: process.env.NODE_ENV || 'development' });
      // Verify SMTP on startup and log result (non-blocking)
      emailService.initialize().catch(() => {});
      // Start scheduled reminders (registration/license expiries)
      startRegistrationLicenseReminderScheduler();
      // Meeting reminders (~1h / ~15m before start, with catch-up if ticks were missed). Tick: MEETING_REMINDER_TICK_MS (default 3m). SMTP required for email.
      startMeetingReminderScheduler();

      // Optional: run catch-up reminders immediately on boot (useful after downtime).
      // These are deduped (notifications) and phase-tracked (meetings), so safe on restarts.
      const runOnBoot = String(process.env.REMINDERS_RUN_ON_BOOT || 'true').toLowerCase() !== 'false';
      if (runOnBoot) {
        setTimeout(() => {
          runMeetingRemindersOnce().catch((err) => logError('Meeting reminders run-on-boot failed', err));
          runRegistrationLicenseRemindersOnce().catch((err) => logError('Reg/license reminders run-on-boot failed', err));
        }, Number(process.env.REMINDERS_RUN_ON_BOOT_DELAY_MS) || 8000);
      }
    });

    const gracefulShutdown = async (signal) => {
      logInfo('Graceful shutdown initiated', { signal });

      server.close(() => {
        logInfo('HTTP server closed');
      });

      try {
        await closeRouterDB();
        await closeAllConnections();
      } catch (error) {
        logError('Error closing database connections', error);
      }

      process.exit(0);
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (error) => {
      logError('Unhandled Promise Rejection', error);
      gracefulShutdown('UNHANDLED_REJECTION');
    });

    process.on('uncaughtException', (error) => {
      logError('Uncaught Exception', error);
      gracefulShutdown('UNCAUGHT_EXCEPTION');
    });

  } catch (error) {
    logError('Failed to start server', error);
    process.exit(1);
  }
};

// Start the server
startServer();
