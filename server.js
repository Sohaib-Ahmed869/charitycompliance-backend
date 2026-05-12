/**
 * Server Entry Point
 * 
 * Starts the Express server and handles graceful shutdown.
 */

import dns from 'node:dns';
import http from 'node:http';
import dotenv from 'dotenv';

// `override: true` makes the .env file the source of truth even when a value
// was previously set in process.env (shell export, PM2 ecosystem, parent
// process). Without this, edits to .env can appear to "not pick up" because
// the existing process.env value silently wins.

dotenv.config({ override: true });

// Ensure Node resolves MongoDB SRV records through a known public resolver
// before any app modules import the database layer.
dns.setServers(['1.1.1.1', '8.8.8.8']);

const [{ default: app, initializeApp }, { closeRouterDB }, { closeAllConnections }, { default: emailService }, { logError, logInfo, logWarn }, { startRegistrationLicenseReminderScheduler }, { startMeetingReminderScheduler }, { runRegistrationLicenseRemindersOnce }, { runMeetingRemindersOnce }, { startFinanceCloseScheduler }, { startFiscalReportReminderScheduler, runFiscalReportRemindersOnce }, { startSuitabilityRenewalScheduler, runSuitabilityRenewalsOnce }, { startSubscriptionMaintenanceReminderScheduler, runSubscriptionMaintenanceRemindersOnce }, { startChatRetentionScheduler }, { initChatSocket }, { startChatMentionDigestScheduler }] = await Promise.all([
  import('./src/app.js'),
  import('./src/config/database.js'),
  import('./src/db/connectionManager.js'),
  import('./src/services/emailService.js'),
  import('./src/utils/logger.js'),
  import('./src/services/registrationLicenseReminderService.js'),
  import('./src/services/meetingReminderService.js'),
  import('./src/services/registrationLicenseReminderService.js'),
  import('./src/services/meetingReminderService.js'),
  import('./src/services/checklistSchedulerService.js'),
  import('./src/services/fiscalReportReminderService.js'),
  import('./src/services/suitabilityReminderService.js'),
  import('./src/services/subscriptionMaintenanceReminderService.js'),
  import('./src/services/chatRetentionService.js'),
  import('./src/services/chatSocketService.js'),
  import('./src/services/chatMentionDigestService.js')
]);

const { startTrialReminderScheduler } = await import('./src/services/trialReminderService.js');
const { startOverrideExpiryScheduler } = await import('./src/services/overrideExpiryService.js');
const { startUsageAggregator } = await import('./src/services/usageAggregator.js');
const { startFoundingCustomerRenewalScheduler } = await import('./src/services/foundingCustomerRenewalService.js');

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

    // Wrap Express in an http.Server so Socket.IO can attach to the same port.
    const httpServer = http.createServer(app);
    initChatSocket(httpServer);
    const server = httpServer.listen(PORT, () => {
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
        // Trial-ending reminders — sweep hourly, email tenants 3 days before
        // their trial ends. Idempotent via trial_reminder_sent_for.
        startTrialReminderScheduler();
        startOverrideExpiryScheduler();
        startUsageAggregator();
        startFoundingCustomerRenewalScheduler();
        // Chat retention: daily sweep that purges expired attachments per channel.retention_days
        startChatRetentionScheduler();
        // Chat mention digest: emails users any unread @mention older than the threshold (default 30 min).
        startChatMentionDigestScheduler();

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
