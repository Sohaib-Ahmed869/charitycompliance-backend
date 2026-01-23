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

// ============================================
// MIDDLEWARE
// ============================================

// CORS Configuration
const corsOptions = {
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:5173'],
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
app.use('/api/v1/platform/organization', organizationRoutes);
app.use('/api/v1/platform/roles', roleRoutes);
app.use('/api/v1/platform/onboarding', onboardingRoutes);
app.use('/api/v1/platform/expenses', expenseRoutes);
app.use('/api/v1/platform/approvals', approvalRoutes);
app.use('/api/v1/platform/board-members', boardMemberRoutes);
app.use('/api/v1/platform/documents', documentRoutes);

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
