/**
 * Organization Service
 * 
 * Business logic for organization management
 */

import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { AppError } from '../middleware/errorHandler.js';
import { logError } from '../utils/logger.js';

export class OrganizationService {
  constructor(tenantDb) {
    this.orgRepo = new OrganizationRepository(tenantDb);
  }

  async getOrganization() {
    try {
      const org = await this.orgRepo.findOne();
      if (!org) {
        throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
      }
      return org;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      logError('Failed to get organization', error);
      throw new AppError('Failed to get organization', 500, 'ORG_FETCH_ERROR');
    }
  }

  async updateOrganization(updateData) {
    try {
      const org = await this.orgRepo.update(updateData);
      return org;
    } catch (error) {
      logError('Failed to update organization', error);
      throw new AppError('Failed to update organization', 500, 'ORG_UPDATE_ERROR');
    }
  }

  async updateSettings(settings) {
    try {
      const org = await this.orgRepo.updateSettings(settings);
      return org;
    } catch (error) {
      logError('Failed to update organization settings', error);
      throw new AppError('Failed to update organization settings', 500, 'ORG_SETTINGS_ERROR');
    }
  }
}
