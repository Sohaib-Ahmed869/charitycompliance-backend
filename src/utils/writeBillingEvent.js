/**
 * One-line helper for writing a BillingEvent. Anywhere in the admin
 * surface that mutates pricing-relevant state should call this.
 *
 * Failure to write the audit row never blocks the underlying action — we
 * log and continue, because surfacing an audit-write error to the user
 * would be worse UX than the rare missed row. The application logger
 * captures the error so ops sees it immediately.
 */

import getRouterModels from '../db/models/routerModels.js';
import { logError } from './logger.js';

export async function writeBillingEvent(req, {
  action,
  targetType = '',
  targetId = '',
  targetLabel = '',
  tenantId = '',
  diff = [],
  reason = '',
  metadata = {},
  status = 'executed'
} = {}) {
  try {
    const { BillingEvent } = getRouterModels();
    await BillingEvent.create({
      action,
      target_type: targetType,
      target_id: String(targetId || ''),
      target_label: targetLabel,
      tenant_id: tenantId,
      actor_id: req?.user?.userId || null,
      actor_email: req?.user?.email || '',
      diff,
      reason,
      metadata,
      status
    });
  } catch (err) {
    logError('Failed to write BillingEvent', err, { action, targetId });
  }
}

export default writeBillingEvent;
