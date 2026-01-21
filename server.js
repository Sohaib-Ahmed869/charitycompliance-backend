/**
 * Server Entry Point
 * 
 * Starts the Express server and handles graceful shutdown.
 */

import app, { initializeApp } from './src/app.js';
import dotenv from 'dotenv';
import { closeRouterDB } from './src/config/database.js';
import { closeAllConnections } from './src/db/connectionManager.js';

dotenv.config();

const PORT = process.env.PORT || 5000;

// Initialize and start server
const startServer = async () => {
  try {
    // Initialize application (connect to Router DB, etc.)
    await initializeApp();

    // Start server
    const server = app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║   Charity Compliance Platform - Backend API              ║
║   Server running on port ${PORT}                          ║
║   Environment: ${process.env.NODE_ENV || 'development'}   ║
╚═══════════════════════════════════════════════════════════╝
      `);
    });

    // Graceful shutdown handler
    const gracefulShutdown = async (signal) => {
      console.log(`\n${signal} received. Starting graceful shutdown...`);

      // Stop accepting new requests
      server.close(() => {
        console.log('HTTP server closed');
      });

      // Close database connections
      try {
        await closeRouterDB();
        await closeAllConnections();
        console.log('Database connections closed');
      } catch (error) {
        console.error('Error closing database connections:', error);
      }

      // Exit process
      process.exit(0);
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught errors
    process.on('unhandledRejection', (error) => {
      console.error('Unhandled Promise Rejection:', error);
      gracefulShutdown('UNHANDLED_REJECTION');
    });

    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      gracefulShutdown('UNCAUGHT_EXCEPTION');
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
};

// Start the server
startServer();
