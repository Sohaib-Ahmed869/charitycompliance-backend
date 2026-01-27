/**
 * Activity Controller
 *
 * Handles HTTP requests for operating activities
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { ActivityRepository } from '../repositories/activityRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { logInfo, logError } from '../utils/logger.js';

export const getActivities = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const activityRepo = new ActivityRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const includeInactive = req.query.includeInactive === 'true';
  const activities = await activityRepo.findByOrgId(org._id, includeInactive);

  res.json({
    success: true,
    data: activities
  });
});

export const getActivityById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { activityId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const activityRepo = new ActivityRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const activity = await activityRepo.findById(activityId);
  if (!activity) {
    throw new AppError('Activity not found', 404, 'NOT_FOUND');
  }

  // Verify activity belongs to this organization
  if (activity.org_id.toString() !== org._id.toString()) {
    throw new AppError('Activity not found', 404, 'NOT_FOUND');
  }

  res.json({
    success: true,
    data: activity
  });
});

export const createActivity = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const activityRepo = new ActivityRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const activityData = {
    org_id: org._id,
    name: req.body.name,
    description: req.body.description,
    link_to_charitable_purpose: req.body.link_to_charitable_purpose,
    beneficiary_group: req.body.beneficiary_group,
    beneficiary_selection_criteria: req.body.beneficiary_selection_criteria,
    estimated_time_allocation: req.body.estimated_time_allocation,
    estimated_money_allocation: req.body.estimated_money_allocation,
    operating_locations: req.body.operating_locations || [],
    overseas_details: req.body.overseas_details || null,
    start_date: req.body.start_date ? new Date(req.body.start_date) : new Date(),
    status: 'active'
  };

  const activity = await activityRepo.create(activityData);

  logInfo('Activity created', { activityId: activity._id, orgId });

  res.status(201).json({
    success: true,
    data: activity
  });
});

export const updateActivity = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { activityId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const activityRepo = new ActivityRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const activity = await activityRepo.findById(activityId);
  if (!activity) {
    throw new AppError('Activity not found', 404, 'NOT_FOUND');
  }

  // Verify activity belongs to this organization
  if (activity.org_id.toString() !== org._id.toString()) {
    throw new AppError('Activity not found', 404, 'NOT_FOUND');
  }

  const updateData = {
    name: req.body.name,
    description: req.body.description,
    link_to_charitable_purpose: req.body.link_to_charitable_purpose,
    beneficiary_group: req.body.beneficiary_group,
    beneficiary_selection_criteria: req.body.beneficiary_selection_criteria,
    estimated_time_allocation: req.body.estimated_time_allocation,
    estimated_money_allocation: req.body.estimated_money_allocation,
    operating_locations: req.body.operating_locations,
    overseas_details: req.body.overseas_details,
    status: req.body.status
  };

  // Remove undefined fields
  Object.keys(updateData).forEach(key => 
    updateData[key] === undefined && delete updateData[key]
  );

  const updatedActivity = await activityRepo.update(activityId, updateData);

  logInfo('Activity updated', { activityId, orgId });

  res.json({
    success: true,
    data: updatedActivity
  });
});

export const deleteActivity = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { activityId } = req.params;
  const tenantDb = await getTenantConnection(orgId);
  const activityRepo = new ActivityRepository(tenantDb);

  const activity = await activityRepo.findById(activityId);
  if (!activity) {
    throw new AppError('Activity not found', 404, 'NOT_FOUND');
  }

  const orgRepo = new OrganizationRepository(tenantDb);
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  // Verify activity belongs to this organization
  if (activity.org_id.toString() !== org._id.toString()) {
    throw new AppError('Activity not found', 404, 'NOT_FOUND');
  }

  await activityRepo.delete(activityId);

  logInfo('Activity deleted', { activityId, orgId });

  res.json({
    success: true,
    message: 'Activity deleted successfully'
  });
});
