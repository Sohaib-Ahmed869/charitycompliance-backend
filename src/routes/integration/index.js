/**
 * Integration API (/api/v1/integration) — server-to-server access for the
 * Calcite Hyper system. Everything here requires a valid `x-api-key`.
 */

import express from 'express';
import { requireApiKey } from '../../middleware/requireApiKey.js';
import tenantRoutes from './tenantRoutes.js';
import planRoutes from './planRoutes.js';
import ticketRoutes from './ticketRoutes.js';

const router = express.Router();

router.use(requireApiKey);

/** GET /integration/ping — confirms the key works. */
router.get('/ping', (req, res) => {
  res.json({ success: true, data: { service: 'stewardex', key: req.integration.name, time: new Date().toISOString() } });
});

router.use(ticketRoutes);
router.use(tenantRoutes);
router.use(planRoutes);

export default router;
