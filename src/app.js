/**
 * Express Application Setup
 * 
 * Configures Express app with middleware, routes, and error handling.
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { connectRouterDB } from './config/database.js';
import { logDebug } from './utils/logger.js';

dotenv.config();

const app = express();

app.set('trust proxy', 1)
// ============================================
// MIDDLEWARE
// ============================================

// CORS Configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173','http://localhost:5174'],
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

// Body Parser
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate Limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

// Request Logging (Development only)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    logDebug('Request', { method: req.method, path: req.path });
    next();
  });
}

// Health Check Endpoint (before auth)
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Charity Compliance API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// ============================================
// ROUTES
// ============================================

// Authentication routes (no auth required)
import authRoutes from './routes/platform/authRoutes.js';
app.use('/api/v1/auth', authRoutes);

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
import meRoutes from './routes/platform/meRoutes.js';
import positionPermissionsRoutes from './routes/platform/positionPermissions.js';
import notificationRoutes from './routes/platform/notificationRoutes.js';
import partnerVettingRoutes from './routes/platform/partnerVettingRoutes.js';
import donorRoutes from './routes/platform/donorRoutes.js';
import projectRegisterRoutes from './routes/platform/projectRegisterRoutes.js';
import fundingAgreementRoutes from './routes/platform/fundingAgreementRoutes.js';
import assetRoutes from './routes/platform/assetRoutes.js';
import coiRoutes from './routes/platform/coiRoutes.js';
import auditTrailRoutes from './routes/platform/auditTrailRoutes.js';
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
import socialMediaCampaignRoutes from './routes/platform/socialMediaCampaignRoutes.js';
import disciplinaryRoutes from './routes/platform/disciplinaryRoutes.js';
import volunteerRoutes from './routes/platform/volunteerRoutes.js';
app.use('/api/v1/platform/organization', organizationRoutes);
app.use('/api/v1/platform/roles', roleRoutes);
app.use('/api/v1/platform/onboarding', onboardingRoutes);
app.use('/api/v1/platform/expenses', expenseRoutes);
app.use('/api/v1/platform/approvals', approvalRoutes);
app.use('/api/v1/platform/approval-thresholds', approvalThresholdRoutes);
app.use('/api/v1/platform/users', userRoutes);
app.use('/api/v1/platform/board-members', boardMemberRoutes);
app.use('/api/v1/platform/documents', documentRoutes);
app.use('/api/v1/platform/activities', activityRoutes);
app.use('/api/v1/platform/calendar', calendarRoutes);
app.use('/api/v1/platform/financial-controls', financialControlsRoutes);
app.use('/api/v1/platform/governance-structure', governanceStructureRoutes);
app.use('/api/v1/platform/training', trainingRoutes);
app.use('/api/v1/platform/risks', riskRoutes);
app.use('/api/v1/platform/policies', policyRoutes);
app.use('/api/v1/platform/me', meRoutes);
app.use('/api/v1/platform/position-permissions', positionPermissionsRoutes);
app.use('/api/v1/platform/notifications', notificationRoutes);
app.use('/api/v1/platform/partner-vetting', partnerVettingRoutes);
app.use('/api/v1/platform/donors', donorRoutes);
app.use('/api/v1/platform/donations', donationRoutes);
app.use('/api/v1/platform/donation-milestones', donationMilestoneRoutes);
app.use('/api/v1/platform/social-media-campaigns', socialMediaCampaignRoutes);
app.use('/api/v1/platform/disciplinary-records', disciplinaryRoutes);
app.use('/api/v1/platform/project-register', projectRegisterRoutes);
app.use('/api/v1/platform/funding-agreements', fundingAgreementRoutes);
app.use('/api/v1/platform/assets', assetRoutes);
app.use('/api/v1/platform/coi', coiRoutes);
app.use('/api/v1/platform/audit-trail', auditTrailRoutes);
app.use('/api/v1/platform/complaints', complaintRoutes);
app.use('/api/v1/platform/meetings', meetingRoutes);
app.use('/api/v1/platform/support-tickets', supportTicketRoutes);
app.use('/api/v1/platform/bcp', bcpRoutes);
app.use('/api/v1/platform/legal-documents', legalDocumentRoutes);
app.use('/api/v1/platform/dashboard', dashboardRoutes);
app.use('/api/v1/platform/chatbot', chatbotRoutes);
app.use('/api/v1/platform/volunteers', volunteerRoutes);

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
