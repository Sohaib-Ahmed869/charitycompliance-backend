/**
 * Repair a tenant whose Stripe checkout completed but whose
 * checkout.session.completed webhook never landed (misconfigured endpoint
 * URL, wrong STRIPE_WEBHOOK_SECRET, or a Render cold-start timeout).
 *
 * Replays exactly what the webhook would have done: retrieves the Checkout
 * Session from Stripe, finds the subscription it created, and writes the
 * local OrganizationSubscription.
 *
 * Usage:   node scripts/reconcileFromCheckout.js <checkout_session_id>
 * Example: node scripts/reconcileFromCheckout.js cs_test_b1P341P6rXDi4zvm...
 *
 * Safe to re-run — applySubscriptionToTenant is find-or-create. Uses the
 * STRIPE_SECRET_KEY / ROUTER_DB_URI from this environment, so run it
 * against whichever environment the stuck tenant lives in.
 */

import dotenv from 'dotenv';
import { connectRouterDB, closeRouterDB } from '../src/config/database.js';
import { isStripeConfigured } from '../src/services/stripeService.js';
import { reconcileFromCheckoutSession } from '../src/services/subscriptionReconciler.js';

dotenv.config();

const sessionId = process.argv[2];

if (!sessionId) {
  console.error('❌ Error: checkout session id is required');
  console.log('Usage: node scripts/reconcileFromCheckout.js <checkout_session_id>');
  console.log('Example: node scripts/reconcileFromCheckout.js cs_test_b1P341P6rXDi4zvm...');
  process.exit(1);
}

async function run() {
  if (!isStripeConfigured()) {
    console.error('❌ STRIPE_SECRET_KEY is not set — cannot talk to Stripe.');
    process.exit(1);
  }

  try {
    console.log('📡 Connecting to Router Database...');
    await connectRouterDB();
    console.log('✅ Connected');

    console.log(`🔧 Reconciling from checkout session: ${sessionId}`);
    const result = await reconcileFromCheckoutSession(sessionId);

    if (result.ok) {
      console.log('✅ Subscription written for tenant:', result.orgId);
      console.log(`   action=${result.action} status=${result.status} stripe_sub=${result.subscriptionId}`);
    } else {
      console.error('❌ Could not reconcile:', result.reason);
      if (result.orgId) console.error('   orgId from session:', result.orgId);
      console.error('   Nothing was written.');
    }

    await closeRouterDB();
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error('❌ Error:', error?.message || error);
    try { await closeRouterDB(); } catch { /* ignore close errors */ }
    process.exit(1);
  }
}

run();
