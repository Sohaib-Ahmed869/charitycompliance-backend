/**
 * ACNC Annual Financial Report (v1) service
 * For v1: same cash-basis totals as AIS, with deeper breakdown and notes.
 */

import { buildAisPrefill } from './aisReportingService.js';

export async function buildAcncFinancialPrefill({ tenantDb, orgId, fyEnd }) {
  const ais = await buildAisPrefill({ tenantDb, orgId, fyEnd });
  // Keep identical shape for charity + financials so frontend can reuse tiles.
  return {
    ...ais,
    report_meta: {
      type: 'acnc_annual_financial_report_v1',
    }
  };
}

