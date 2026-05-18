/**
 * Router DB Models
 * 
 * Mongoose models for Router Database collections.
 * These models are used with the Router DB connection.
 */

import { getRouterConnection } from '../../config/database.js';
import tenantSchema from '../schemas/router/tenantSchema.js';
import subscriptionPlanSchema from '../schemas/router/subscriptionPlanSchema.js';
import organizationSubscriptionSchema from '../schemas/router/organizationSubscriptionSchema.js';
import paymentSchema from '../schemas/router/paymentSchema.js';
import websiteLeadSchema from '../schemas/router/websiteLeadSchema.js';
import planRevisionSchema from '../schemas/router/planRevisionSchema.js';
import featureFlagSchema from '../schemas/router/featureFlagSchema.js';
import superAdminSchema from '../schemas/router/superAdminSchema.js';
import billingEventSchema from '../schemas/router/billingEventSchema.js';
import couponSchema from '../schemas/router/couponSchema.js';
import subscriptionOverrideSchema from '../schemas/router/subscriptionOverrideSchema.js';
import marketplacePolicyGroupSchema from '../schemas/router/marketplacePolicyGroupSchema.js';
import marketplacePolicySchema from '../schemas/router/marketplacePolicySchema.js';
import marketplacePurchaseSchema from '../schemas/router/marketplacePurchaseSchema.js';

let routerConnection = null;

const getRouterModels = () => {
  if (!routerConnection) {
    routerConnection = getRouterConnection();
  }

  return {
    Tenant: routerConnection.model('Tenant', tenantSchema),
    SubscriptionPlan: routerConnection.model('SubscriptionPlan', subscriptionPlanSchema),
    PlanRevision: routerConnection.model('PlanRevision', planRevisionSchema),
    FeatureFlag: routerConnection.model('FeatureFlag', featureFlagSchema),
    SuperAdmin: routerConnection.model('SuperAdmin', superAdminSchema),
    BillingEvent: routerConnection.model('BillingEvent', billingEventSchema),
    Coupon: routerConnection.model('Coupon', couponSchema),
    SubscriptionOverride: routerConnection.model('SubscriptionOverride', subscriptionOverrideSchema),
    OrganizationSubscription: routerConnection.model('OrganizationSubscription', organizationSubscriptionSchema),
    Payment: routerConnection.model('Payment', paymentSchema),
    WebsiteLead: routerConnection.model('WebsiteLead', websiteLeadSchema),
    MarketplacePolicyGroup: routerConnection.model('MarketplacePolicyGroup', marketplacePolicyGroupSchema),
    MarketplacePolicy: routerConnection.model('MarketplacePolicy', marketplacePolicySchema),
    MarketplacePurchase: routerConnection.model('MarketplacePurchase', marketplacePurchaseSchema)
  };
};

export default getRouterModels;
