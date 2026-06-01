/**
 * Express Application Setup
 * 
 * Configures Express app with middleware, routes, and error handling.
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { connectRouterDB, getRouterConnection } from './config/database.js';
import { logDebug, logInfo, logWarn } from './utils/logger.js';

dotenv.config();

const disabledModules = new Set(
  String(process.env.DISABLED_MODULES || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
);
const isModuleEnabled = (name) => !disabledModules.has(String(name || '').toLowerCase());

const app = express();

app.set('trust proxy', 1)
// ============================================
// MIDDLEWARE
// ============================================

// CORS Configuration
const configuredOrigins = [
  ...(String(process.env.CORS_ORIGIN || '').split(',').map((v) => v.trim()).filter(Boolean)),
  ...(String(process.env.FRONTEND_URL || '').split(',').map((v) => v.trim()).filter(Boolean)),
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000'
];
const allowedOrigins = Array.from(new Set(configuredOrigins));
const isAllowedOrigin = (origin) => {
  if (!origin) return true; // non-browser or same-origin calls
  const normalized = String(origin).trim().replace(/\/$/, '');
  if (allowedOrigins.some((allowed) => normalized === String(allowed).replace(/\/$/, ''))) {
    return true;
  }
  // Allow localhost on arbitrary dev ports to avoid repeated env churn.
  if (/^https?:\/\/localhost(?::\d+)?$/i.test(normalized)) return true;
  return false;
};

logInfo('CORS allowlist loaded', {
  count: allowedOrigins.length,
  origins: allowedOrigins
});

// Optional: set CORS_DEBUG=true on Render to log every request's Origin (preflight + API).
if (String(process.env.CORS_DEBUG || '').toLowerCase() === 'true') {
  app.use((req, _res, next) => {
    logInfo('CORS debug', {
      method: req.method,
      path: req.path,
      origin: req.headers.origin || '(none)'
    });
    next();
  });
}

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    // Do not pass Error here: next(err) can skip CORS headers on the response and the browser
    // reports a generic "CORS" failure. Reject with false and log instead.
    logWarn('CORS origin rejected', {
      origin: origin || '(missing)',
      hint: 'Add exact scheme+host+port to CORS_ORIGIN or FRONTEND_URL on the server, then redeploy.'
    });
    return callback(null, false);
  },
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Stripe webhook MUST be mounted BEFORE express.json() — Stripe signs
// the raw bytes, so the JSON parser would invalidate the signature.
// The webhook router uses express.raw() locally to keep req.body as Buffer.
import stripeWebhookRoutes from './routes/webhooks/stripeWebhookRoutes.js';
app.use('/api/v1/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookRoutes);

// Body Parser
const requestBodyLimit = process.env.REQUEST_BODY_LIMIT || '50mb';
app.use(express.json({ limit: requestBodyLimit }));
app.use(express.urlencoded({ extended: true, limit: requestBodyLimit }));

// Rate limiting intentionally disabled — the dashboard fans out ~20 parallel
// queries per load and a shared tenant hits global IP limits immediately,
// producing spurious 429s. If abuse protection is needed later, re-introduce
// a per-tenant (not per-IP) limiter rather than a global one.

// Request Logging (Development only)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    logDebug('Request', { method: req.method, path: req.path });
    next();
  });
}

// ============================================
// HEALTH CHECK
// ============================================
//
// Two flavours, both unauthenticated:
//
//   GET /health          - LIVENESS. Returns 200 the moment Express
//                          is responsive. No DB ping. This is what
//                          the AWS load balancer / target group
//                          should hit to decide whether to keep the
//                          instance in rotation. We don't want a
//                          transient Mongo blip to deregister us.
//
//   GET /api/v1/health   - READINESS. Pings the Router DB and only
//                          returns 200 when Mongo is connected. This
//                          is what the deploy pipeline + smoke tests
//                          hit after a pm2 reload to confirm the
//                          new process can actually serve requests.
//                          Returns 503 (NOT 200) when the DB is down,
//                          so a broken deploy fails fast.
//
// We also alias readiness at `/healthz` for any kubernetes-style
// probe that goes looking for it by convention.

// Liveness: cheap, always green if the event loop is alive.
app.get('/health', (_req, res) => {
  res.json({
    success: true,
    status: 'live',
    message: 'Charity Compliance API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    uptime_s: Math.floor(process.uptime())
  });
});

// Readiness: confirms the Router DB is connected and answers a ping.
// Uses a 1.5s timeout so a half-dead Mongo doesn't keep the health
// check hanging indefinitely.
const readinessHandler = async (_req, res) => {
  const started = Date.now();
  let dbState = 'unknown';
  let dbOk = false;
  let dbPingMs = null;

  try {
    const conn = getRouterConnection();
    // mongoose readyState: 0 disconnected, 1 connected, 2 connecting, 3 disconnecting
    const stateMap = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
    dbState = stateMap[conn.readyState] || `state-${conn.readyState}`;

    if (conn.readyState === 1) {
      const pingStart = Date.now();
      // 1.5s race so a wedged primary doesn't stall the response.
      await Promise.race([
        conn.db.admin().command({ ping: 1 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 1500))
      ]);
      dbPingMs = Date.now() - pingStart;
      dbOk = true;
    }
  } catch (err) {
    dbState = `error: ${err.message || 'unknown'}`;
    dbOk = false;
  }

  const status = dbOk ? 200 : 503;
  res.status(status).json({
    success: dbOk,
    status: dbOk ? 'ready' : 'not-ready',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    uptime_s: Math.floor(process.uptime()),
    checks: {
      router_db: {
        state: dbState,
        ping_ms: dbPingMs
      }
    },
    elapsed_ms: Date.now() - started
  });
};

app.get('/api/v1/health', readinessHandler);
app.get('/healthz',         readinessHandler);

// ============================================
// ROUTES
// ============================================

// Authentication routes (no auth required)
import authRoutes from './routes/platform/authRoutes.js';
app.use('/api/v1/auth', authRoutes);

// Public, unauthenticated marketing data (used by the /pricing page on the
// public site). No tenant context, no auth middleware — read-only catalogue.
import publicPlansRoutes from './routes/public/publicPlansRoutes.js';
app.use('/api/v1/public/plans', publicPlansRoutes);

// Public-facing policy marketplace (guest checkout, no JWT).
import publicMarketplaceRoutes from './routes/public/publicMarketplaceRoutes.js';
app.use('/api/v1/public/marketplace', publicMarketplaceRoutes);

// Platform routes (auth required)
import organizationRoutes from './routes/platform/organizationRoutes.js';
import roleRoutes from './routes/platform/roleRoutes.js';
import onboardingRoutes from './routes/platform/onboardingRoutes.js';
import expenseRoutes from './routes/platform/expenseRoutes.js';
import approvalRoutes from './routes/platform/approvalRoutes.js';
import boardMemberRoutes from './routes/platform/boardMemberRoutes.js';
import documentRoutes from './routes/platform/documentRoutes.js';
import activityRoutes from './routes/platform/activityRoutes.js';
import calendarRoutes from './routes/platform/calendarRoutes.js';
import financialControlsRoutes from './routes/platform/financialControlsRoutes.js';
import governanceStructureRoutes from './routes/platform/governanceStructureRoutes.js';
import trainingRoutes from './routes/platform/trainingRoutes.js';
import riskRoutes from './routes/platform/riskRoutes.js';
import policyRoutes from './routes/platform/policyRoutes.js';
import marketplaceRoutes from './routes/platform/marketplaceRoutes.js';
import meRoutes from './routes/platform/meRoutes.js';
import positionPermissionsRoutes from './routes/platform/positionPermissions.js';
import notificationRoutes from './routes/platform/notificationRoutes.js';
import partnerVettingRoutes from './routes/platform/partnerVettingRoutes.js';
import donorRoutes from './routes/platform/donorRoutes.js';
import fundingProgramRoutes from './routes/platform/fundingProgramRoutes.js';
import projectRegisterRoutes from './routes/platform/projectRegisterRoutes.js';
import fundingAgreementRoutes from './routes/platform/fundingAgreementRoutes.js';
import assetRoutes from './routes/platform/assetRoutes.js';
import coiRoutes from './routes/platform/coiRoutes.js';
import auditTrailRoutes from './routes/platform/auditTrailRoutes.js';
import reportingRoutes from './routes/platform/reportingRoutes.js';
import approvalThresholdRoutes from './routes/platform/approvalThresholdRoutes.js';
import userRoutes from './routes/platform/userRoutes.js';
import complaintRoutes from './routes/platform/complaintRoutes.js';
import meetingRoutes from './routes/platform/meetingRoutes.js';
import supportTicketRoutes from './routes/platform/supportTicketRoutes.js';
import bcpRoutes from './routes/platform/bcpRoutes.js';
import legalDocumentRoutes from './routes/platform/legalDocumentRoutes.js';
import dashboardRoutes from './routes/platform/dashboardRoutes.js';
import chatbotRoutes from './routes/platform/chatbotRoutes.js';
import donationRoutes from './routes/platform/donationRoutes.js';
import donationMilestoneRoutes from './routes/platform/donationMilestoneRoutes.js';
import donationBoxRoutes from './routes/platform/donationBoxRoutes.js';
import socialMediaCampaignRoutes from './routes/platform/socialMediaCampaignRoutes.js';
import disciplinaryRoutes from './routes/platform/disciplinaryRoutes.js';
import volunteerRoutes from './routes/platform/volunteerRoutes.js';
import projectDeliveryRoutes from './routes/platform/projectDeliveryRoutes.js';
import checklistRoutes from './routes/platform/checklistRoutes.js';
import itRegisterRoutes from './routes/platform/itRegisterRoutes.js';
import offboardingRoutes from './routes/platform/offboardingRoutes.js';
import sweepFundsRoutes from './routes/platform/sweepFundsRoutes.js';
import chatRoutes from './routes/platform/chatRoutes.js';
// Calcite SuperAdmin portal (separate /admin namespace, isolated from tenant routes).
import adminPlanRoutes from './routes/admin/planRoutes.js';
import adminAuthRoutes from './routes/admin/authRoutes.js';
import adminOpsRoutes from './routes/admin/opsRoutes.js';
import adminStaffRoutes from './routes/admin/staffRoutes.js';
import adminTicketsRoutes from './routes/admin/ticketsRoutes.js';
import adminApprovalsRoutes from './routes/admin/approvalsRoutes.js';
import adminMarketplacePoliciesRoutes from './routes/admin/marketplacePoliciesRoutes.js';
import { requireIpAllowlist } from './middleware/requireIpAllowlist.js';
import billingRoutes from './routes/platform/billingRoutes.js';
app.use('/api/v1/platform/organization', organizationRoutes);
app.use('/api/v1/platform/roles', roleRoutes);
app.use('/api/v1/platform/onboarding', onboardingRoutes);
if (isModuleEnabled('expenses')) app.use('/api/v1/platform/expenses', expenseRoutes);
if (isModuleEnabled('approvals')) app.use('/api/v1/platform/approvals', approvalRoutes);
if (isModuleEnabled('checklists')) app.use('/api/v1/platform/checklists', checklistRoutes);
if (isModuleEnabled('approval-thresholds')) app.use('/api/v1/platform/approval-thresholds', approvalThresholdRoutes);
app.use('/api/v1/platform/users', userRoutes);
if (isModuleEnabled('board-members')) app.use('/api/v1/platform/board-members', boardMemberRoutes);
if (isModuleEnabled('documents')) app.use('/api/v1/platform/documents', documentRoutes);
if (isModuleEnabled('activities')) app.use('/api/v1/platform/activities', activityRoutes);
if (isModuleEnabled('calendar')) app.use('/api/v1/platform/calendar', calendarRoutes);
if (isModuleEnabled('financial-controls')) app.use('/api/v1/platform/financial-controls', financialControlsRoutes);
if (isModuleEnabled('governance-structure')) app.use('/api/v1/platform/governance-structure', governanceStructureRoutes);
if (isModuleEnabled('training')) app.use('/api/v1/platform/training', trainingRoutes);
if (isModuleEnabled('risks')) app.use('/api/v1/platform/risks', riskRoutes);
if (isModuleEnabled('policies')) app.use('/api/v1/platform/policies', policyRoutes);
if (isModuleEnabled('policies')) app.use('/api/v1/platform/marketplace', marketplaceRoutes);
app.use('/api/v1/platform/me', meRoutes);
if (isModuleEnabled('position-permissions')) app.use('/api/v1/platform/position-permissions', positionPermissionsRoutes);
if (isModuleEnabled('notifications')) app.use('/api/v1/platform/notifications', notificationRoutes);
if (isModuleEnabled('partner-vetting')) app.use('/api/v1/platform/partner-vetting', partnerVettingRoutes);
if (isModuleEnabled('donors')) app.use('/api/v1/platform/donors', donorRoutes);
if (isModuleEnabled('funding-programs')) app.use('/api/v1/platform/funding-programs', fundingProgramRoutes);
if (isModuleEnabled('donations')) app.use('/api/v1/platform/donations', donationRoutes);
if (isModuleEnabled('donation-milestones')) app.use('/api/v1/platform/donation-milestones', donationMilestoneRoutes);
if (isModuleEnabled('donation-boxes')) app.use('/api/v1/platform/donation-boxes', donationBoxRoutes);
if (isModuleEnabled('social-media-campaigns')) app.use('/api/v1/platform/social-media-campaigns', socialMediaCampaignRoutes);
if (isModuleEnabled('disciplinary-records')) app.use('/api/v1/platform/disciplinary-records', disciplinaryRoutes);
if (isModuleEnabled('project-register')) app.use('/api/v1/platform/project-register', projectRegisterRoutes);
if (isModuleEnabled('funding-agreements')) app.use('/api/v1/platform/funding-agreements', fundingAgreementRoutes);
if (isModuleEnabled('assets')) app.use('/api/v1/platform/assets', assetRoutes);
if (isModuleEnabled('coi')) app.use('/api/v1/platform/coi', coiRoutes);
if (isModuleEnabled('audit-trail')) app.use('/api/v1/platform/audit-trail', auditTrailRoutes);
if (isModuleEnabled('reporting')) app.use('/api/v1/platform/reporting', reportingRoutes);
if (isModuleEnabled('complaints')) app.use('/api/v1/platform/complaints', complaintRoutes);
if (isModuleEnabled('meetings')) app.use('/api/v1/platform/meetings', meetingRoutes);
if (isModuleEnabled('support-tickets')) app.use('/api/v1/platform/support-tickets', supportTicketRoutes);
if (isModuleEnabled('bcp')) app.use('/api/v1/platform/bcp', bcpRoutes);
if (isModuleEnabled('legal-documents')) app.use('/api/v1/platform/legal-documents', legalDocumentRoutes);
if (isModuleEnabled('dashboard')) app.use('/api/v1/platform/dashboard', dashboardRoutes);
if (isModuleEnabled('chatbot')) app.use('/api/v1/platform/chatbot', chatbotRoutes);
if (isModuleEnabled('volunteers')) app.use('/api/v1/platform/volunteers', volunteerRoutes);
if (isModuleEnabled('project-delivery')) app.use('/api/v1/platform/project-delivery', projectDeliveryRoutes);
if (isModuleEnabled('it-register')) app.use('/api/v1/platform/it-register', itRegisterRoutes);
if (isModuleEnabled('offboarding')) app.use('/api/v1/platform/offboarding', offboardingRoutes);
if (isModuleEnabled('sweep-funds')) app.use('/api/v1/platform/sweep-funds', sweepFundsRoutes);
if (isModuleEnabled('chat')) app.use('/api/v1/platform/chat', chatRoutes);

// Calcite SuperAdmin portal — sits outside the /platform namespace.
// Auth (login + me) is public; everything else is gated by
// requireSuperAdmin (Sprint 1: read-only catalogue browsing).
//
// Network-level allowlist runs FIRST so credential probes never reach
// auth. Set CALCITE_ADMIN_IP_ALLOWLIST env to enable; empty = open
// (development default).
app.use('/api/v1/admin', requireIpAllowlist);

app.use('/api/v1/admin/auth', adminAuthRoutes);
app.use('/api/v1/admin', adminPlanRoutes);
app.use('/api/v1/admin', adminOpsRoutes);
app.use('/api/v1/admin', adminStaffRoutes);
app.use('/api/v1/admin', adminTicketsRoutes);
app.use('/api/v1/admin', adminApprovalsRoutes);
app.use('/api/v1/admin', adminMarketplacePoliciesRoutes);
app.use('/api/v1/platform/billing', billingRoutes);

// API info route
app.get('/api/v1', (req, res) => {
  res.json({
    success: true,
    message: 'Charity Compliance API v1',
    version: '1.0.0'
  });
});

// ============================================
// ERROR HANDLING
// ============================================

// 404 Handler (must be after all routes)
app.use(notFoundHandler);

// Error Handler (must be last)
app.use(errorHandler);

// ============================================
// INITIALIZATION
// ============================================

/**
 * Initialize application
 * Connects to Router DB and performs startup tasks
 */
export const initializeApp = async () => {
  try {
    await connectRouterDB();
  } catch (error) {
    throw error;
  }
};

export default app;
