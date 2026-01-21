/**
 * Router Database Initialization Script
 * 
 * Creates required collections and indexes in Router DB.
 * Run this once after setting up your Router DB cluster.
 * 
 * Usage: node scripts/initRouterDB.js
 */

import { connectRouterDB } from '../src/config/database.js';
import { logInfo, logError } from '../src/utils/logger.js';

const initRouterDB = async () => {
  try {
    logInfo('Connecting to Router Database...');
    const routerDB = await connectRouterDB();

    logInfo('Creating collections and indexes...');

    // Tenants Collection
    const tenantsCollection = routerDB.collection('tenants');
    await tenantsCollection.createIndex({ orgId: 1 }, { unique: true });
    await tenantsCollection.createIndex({ status: 1 });
    logInfo('Created tenants collection with indexes');

    // Subscription Plans Collection
    const plansCollection = routerDB.collection('subscription_plans');
    await plansCollection.createIndex({ plan_code: 1 }, { unique: true });
    await plansCollection.createIndex({ is_active: 1 });
    logInfo('Created subscription_plans collection with indexes');

    // Organization Subscriptions Collection
    const subscriptionsCollection = routerDB.collection('organization_subscription');
    await subscriptionsCollection.createIndex({ organization_id: 1 });
    await subscriptionsCollection.createIndex({ stripe_subscription_id: 1 }, { unique: true, sparse: true });
    await subscriptionsCollection.createIndex({ status: 1 });
    await subscriptionsCollection.createIndex({ current_period_end: 1 });
    logInfo('Created organization_subscription collection with indexes');

    // Payments Collection
    const paymentsCollection = routerDB.collection('payments');
    await paymentsCollection.createIndex({ organization_id: 1 });
    await paymentsCollection.createIndex({ stripe_payment_id: 1 }, { unique: true, sparse: true });
    await paymentsCollection.createIndex({ payment_date: -1 });
    await paymentsCollection.createIndex({ status: 1 });
    logInfo('Created payments collection with indexes');

    // Website Leads Collection
    const leadsCollection = routerDB.collection('website_leads');
    await leadsCollection.createIndex({ email: 1 });
    await leadsCollection.createIndex({ captured_at: -1 });
    await leadsCollection.createIndex({ is_converted: 1 });
    logInfo('Created website_leads collection with indexes');

    logInfo('Router Database initialization completed successfully');

    // Seed default subscription plans
    await seedSubscriptionPlans(plansCollection);

    process.exit(0);
  } catch (error) {
    logError('Failed to initialize Router Database', error);
    process.exit(1);
  }
};

const seedSubscriptionPlans = async (plansCollection) => {
  const existingPlans = await plansCollection.countDocuments();
  if (existingPlans > 0) {
    logInfo('Subscription plans already exist, skipping seed');
    return;
  }

  const defaultPlans = [
    {
      plan_code: 'free',
      plan_name: 'Free',
      monthly_price: 0,
      yearly_price: 0,
      features: {
        max_users: 5,
        max_storage_gb: 1,
        modules: ['dashboard', 'basic_approvals'],
        support: 'community',
        analytics: false,
        integrations: false
      },
      is_active: true,
      created_at: new Date()
    },
    {
      plan_code: 'standard',
      plan_name: 'Standard',
      monthly_price: 99,
      yearly_price: 990,
      features: {
        max_users: 25,
        max_storage_gb: 10,
        modules: ['all'],
        support: 'email',
        analytics: false,
        integrations: ['xero']
      },
      is_active: true,
      created_at: new Date()
    },
    {
      plan_code: 'premium',
      plan_name: 'Premium',
      monthly_price: 299,
      yearly_price: 2990,
      features: {
        max_users: 100,
        max_storage_gb: 50,
        modules: ['all'],
        support: 'priority',
        analytics: true,
        integrations: ['xero', 'stripe'],
        predictive_risk: true,
        audit_reports: true
      },
      is_active: true,
      created_at: new Date()
    },
    {
      plan_code: 'enterprise',
      plan_name: 'Enterprise',
      monthly_price: 999,
      yearly_price: 9990,
      features: {
        max_users: -1,
        max_storage_gb: -1,
        modules: ['all'],
        support: 'dedicated',
        analytics: true,
        integrations: ['all'],
        predictive_risk: true,
        audit_reports: true,
        custom_workflows: true,
        ai_insights: true,
        dedicated_support: true
      },
      is_active: true,
      created_at: new Date()
    }
  ];

  await plansCollection.insertMany(defaultPlans);
  logInfo('Seeded default subscription plans');
};

initRouterDB();
