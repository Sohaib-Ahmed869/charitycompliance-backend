/**
 * Reporting controller: AIS + ACNC annual financial report
 */

import { asyncHandler } from '../middleware/errorHandler.js';
import { getTenantConnection } from '../db/connectionManager.js';
import { buildAisPrefill } from '../services/aisReportingService.js';
import { buildAcncFinancialPrefill } from '../services/acncFinancialReportService.js';
import { generateAisPdf, generateAcncFinancialPdf } from '../services/acncPdfService.js';
import { generateAisDocx } from '../services/aisDocxService.js';

export const getAisPrefill = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const fyEnd = req.query.fyEnd;
  const tenantDb = await getTenantConnection(orgId);
  const data = await buildAisPrefill({ tenantDb, orgId, fyEnd });
  res.json({ success: true, data });
});

export const getAcncFinancialPrefill = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const fyEnd = req.query.fyEnd;
  const tenantDb = await getTenantConnection(orgId);
  const data = await buildAcncFinancialPrefill({ tenantDb, orgId, fyEnd });
  res.json({ success: true, data });
});

// PDF endpoints are implemented in the next todo (Puppeteer generation).
export const downloadAisPdf = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const fyEnd = req.query.fyEnd;
  const tenantDb = await getTenantConnection(orgId);
  const prefill = await buildAisPrefill({ tenantDb, orgId, fyEnd });
  const pdf = await generateAisPdf({ prefill, overrides: req.body || {} });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="acnc-ais-report-fy-${String(fyEnd)}.pdf"`);
  res.end(pdf);
});

export const downloadAisDocx = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const fyEnd = req.query.fyEnd;
  const tenantDb = await getTenantConnection(orgId);
  const prefill = await buildAisPrefill({ tenantDb, orgId, fyEnd });
  const docx = await generateAisDocx({ prefill, overrides: req.body || {} });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="acnc-ais-report-fy-${String(fyEnd)}.docx"`);
  res.end(docx);
});

export const downloadAcncFinancialPdf = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const fyEnd = req.query.fyEnd;
  const tenantDb = await getTenantConnection(orgId);
  const prefill = await buildAcncFinancialPrefill({ tenantDb, orgId, fyEnd });
  const pdf = await generateAcncFinancialPdf({ prefill, overrides: req.body || {} });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="acnc-annual-financial-report-fy-${String(fyEnd)}.pdf"`);
  res.end(pdf);
});

