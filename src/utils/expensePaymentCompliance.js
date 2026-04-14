/**
 * Australian ABN checksum + payment compliance rules before expense payment authorization.
 */

import { AppError } from '../middleware/errorHandler.js';

export const PAYMENT_COMPLIANCE_HIGH_VALUE_AUD = 5000;

const GST_TREATMENTS = ['gst_inclusive', 'gst_exclusive', 'not_registered'];

export function normalizeAbnDigits(input) {
  if (input == null) return null;
  const compact = String(input).replace(/\s/g, '');
  const m = compact.match(/\d{11}/);
  return m ? m[0] : null;
}

export function isValidAbnChecksum(abn11) {
  if (!abn11 || !/^\d{11}$/.test(abn11)) return false;
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    let d = parseInt(abn11[i], 10);
    if (i === 0) d -= 1;
    sum += d * weights[i];
  }
  return sum % 89 === 0;
}

function parseAmount(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : 0;
}

/**
 * @param {object} input - Raw payment_compliance from client
 * @param {number} expenseAmount - expense.amount
 * @param {string} userId - Mongo user id string
 */
export function buildPaymentComplianceCheckpoint(input = {}, expenseAmount, userId) {
  const manualOverride = Boolean(input.manual_override);
  const overrideComment = String(input.override_comment || '').trim();

  const supplierAbn = normalizeAbnDigits(input.supplier_abn);
  const abnChecksumValid = supplierAbn ? isValidAbnChecksum(supplierAbn) : false;

  const gstTreatment = String(input.gst_treatment || '').trim();
  const gstOk = GST_TREATMENTS.includes(gstTreatment);

  const supplierClaimsTaxExempt = Boolean(input.supplier_claims_tax_exempt);
  const gstConsistent =
    !supplierClaimsTaxExempt || gstTreatment === 'not_registered';

  const amount = parseAmount(expenseAmount);
  const highValue = amount > PAYMENT_COMPLIANCE_HIGH_VALUE_AUD;
  const highValueAcknowledged = Boolean(input.high_value_acknowledged);

  let complianceStatus = 'pending';
  if (!supplierAbn) {
    complianceStatus = 'pending';
  } else if (!abnChecksumValid) {
    complianceStatus = 'failed';
  } else if (!gstOk || !gstConsistent) {
    complianceStatus = 'pending';
  } else if (highValue && !highValueAcknowledged) {
    complianceStatus = 'pending';
  } else {
    complianceStatus = 'verified';
  }

  const canProceed =
    manualOverride
      ? overrideComment.length > 0
      : complianceStatus === 'verified';

  const storedStatus =
    manualOverride && overrideComment.length > 0 ? 'verified' : complianceStatus;

  return {
    checkpoint: {
      supplier_abn: supplierAbn,
      abn_checksum_valid: abnChecksumValid,
      gst_treatment: gstOk ? gstTreatment : null,
      supplier_claims_tax_exempt: supplierClaimsTaxExempt,
      gst_consistent: gstConsistent,
      expense_amount_snapshot: amount,
      high_value_threshold_exceeded: highValue,
      high_value_acknowledged: highValueAcknowledged,
      compliance_status: storedStatus,
      manual_override: manualOverride,
      override_comment: manualOverride ? overrideComment : null,
      recorded_by: userId,
      recorded_at: new Date()
    },
    canProceed,
    manualOverride,
    overrideComment
  };
}

export function assertCheckpointAllowsPaymentAcceptance(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    return;
  }
  const { compliance_status, manual_override, override_comment } = checkpoint;
  const comment = String(override_comment || '').trim();
  if (manual_override && comment) {
    return;
  }
  if (compliance_status === 'verified') {
    return;
  }
  throw new AppError(
    'Tax compliance checkpoint must be verified before payment can be authorized',
    400,
    'PAYMENT_COMPLIANCE_BLOCKED'
  );
}
