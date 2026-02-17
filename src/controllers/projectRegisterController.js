/**
 * Project Register Controller
 *
 * HTTP handlers for project registration
 */

import { validationResult } from 'express-validator';
import { asyncHandler } from '../middleware/errorHandler.js';
import { ProjectRegisterService } from '../services/projectRegisterService.js';

export const createProject = asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: errors.array()
      }
    });
  }

  const orgId = req.orgId;
  const userId = req.user?.userId || req.userId;
  const service = new ProjectRegisterService(orgId);
  const project = await service.createProject({
    ...req.body,
    submitted_by: userId
  });

  res.status(201).json({
    success: true,
    data: project
  });
});

export const getProjects = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const filters = {
    status: req.query.status,
    search: req.query.search
  };

  const service = new ProjectRegisterService(orgId);
  const projects = await service.getProjects(filters);

  res.json({
    success: true,
    data: projects
  });
});

export const getProjectCounts = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const service = new ProjectRegisterService(orgId);
  const counts = await service.getProjectCounts();

  res.json({
    success: true,
    data: counts
  });
});

export const getProjectById = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const { projectId } = req.params;

  const service = new ProjectRegisterService(orgId);
  const project = await service.getProjectById(projectId);

  res.json({
    success: true,
    data: project
  });
});
