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
import { startFinanceCloseScheduler } from './src/services/checklistSchedulerService.js';
import { startFiscalReportReminderScheduler, runFiscalReportRemindersOnce } from './src/services/fiscalReportReminderService.js';
import { startSuitabilityRenewalScheduler, runSuitabilityRenewalsOnce } from './src/services/suitabilityReminderService.js';
import { startSubscriptionMaintenanceReminderScheduler, runSubscriptionMaintenanceRemindersOnce } from './src/services/subscriptionMaintenanceReminderService.js';

dotenv.config();

const PORT = process.env.PORT || 5000;
const isDevelopment = String(process.env.NODE_ENV || '').toLowerCase() === 'development';
const backgroundJobsEnabled =
  String(process.env.BACKGROUND_JOBS_ENABLED || '').toLowerCase() === 'true' ||
  (!isDevelopment && String(process.env.BACKGROUND_JOBS_ENABLED || '').toLowerCase() !== 'false');

// Initialize and start server
const startServer = async () => {
  try {
    // Initialize application (connect to Router DB, etc.)
    await initializeApp();

    const server = app.listen(PORT, () => {
      logInfo('Server started', { port: PORT, environment: process.env.NODE_ENV || 'development' });
      // Verify SMTP on startup and log result (non-blocking)
      emailService.initialize().catch(() => {});
      if (backgroundJobsEnabled) {
        // Start scheduled reminders (registration/license expiries)
        startRegistrationLicenseReminderScheduler();
        // Meeting reminders (~1h / ~15m before start, with catch-up if ticks were missed). Tick: MEETING_REMINDER_TICK_MS (default 3m). SMTP required for email.
        startMeetingReminderScheduler();
        // Finance close: auto-generate month-end / quarter-end checklist workflows.
        startFinanceCloseScheduler();
        startFiscalReportReminderScheduler();
        startSuitabilityRenewalScheduler();
        startSubscriptionMaintenanceReminderScheduler();

        // Optional: run catch-up reminders immediately on boot (useful after downtime).
        // These are deduped (notifications) and phase-tracked (meetings), so safe on restarts.
        const runOnBoot = String(process.env.REMINDERS_RUN_ON_BOOT || 'true').toLowerCase() !== 'false';
        if (runOnBoot) {
          setTimeout(() => {
            runMeetingRemindersOnce().catch((err) => logError('Meeting reminders run-on-boot failed', err));
            runRegistrationLicenseRemindersOnce().catch((err) => logError('Reg/license reminders run-on-boot failed', err));
            runFiscalReportRemindersOnce().catch((err) => logError('Fiscal report reminders run-on-boot failed', err));
            runSuitabilityRenewalsOnce().catch((err) => logError('Suitability renewals run-on-boot failed', err));
            runSubscriptionMaintenanceRemindersOnce().catch((err) => logError('Subscription maintenance reminders run-on-boot failed', err));
          }, Number(process.env.REMINDERS_RUN_ON_BOOT_DELAY_MS) || 8000);
        }
      } else {
        logWarn('Background jobs disabled for this runtime', {
          backgroundJobsEnabled,
          nodeEnv: process.env.NODE_ENV || 'development',
          hint: 'Set BACKGROUND_JOBS_ENABLED=true to enable schedulers in this environment.'
        });
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
