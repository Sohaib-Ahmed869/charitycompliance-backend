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

// Request Logging (Development)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
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

// API Routes will be added here
// Example:
// import authRoutes from './routes/platform/authRoutes.js';
// app.use('/api/v1/auth', authRoutes);

// Placeholder route
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
    // Connect to Router Database
    await connectRouterDB();
    console.log('✅ Application initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize application:', error);
    throw error;
  }
};

export default app;
