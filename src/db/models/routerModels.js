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

let routerConnection = null;

const getRouterModels = () => {
  if (!routerConnection) {
    routerConnection = getRouterConnection();
  }

  return {
    Tenant: routerConnection.model('Tenant', tenantSchema),
    SubscriptionPlan: routerConnection.model('SubscriptionPlan', subscriptionPlanSchema),
    OrganizationSubscription: routerConnection.model('OrganizationSubscription', organizationSubscriptionSchema),
    Payment: routerConnection.model('Payment', paymentSchema),
    WebsiteLead: routerConnection.model('WebsiteLead', websiteLeadSchema)
  };
};

export default getRouterModels;
