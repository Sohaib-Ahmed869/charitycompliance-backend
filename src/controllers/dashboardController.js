import { asyncHandler } from '../middleware/errorHandler.js';
import { DashboardService } from '../services/dashboardService.js';

export const getDashboardStats = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const dashboardService = new DashboardService(orgId);
  const stats = await dashboardService.getAggregatedStats();

  res.json({
    success: true,
    data: stats,
  });
});
