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
      const plain = org.toObject ? org.toObject() : org;
      if (plain.logo_url && String(plain.logo_url).startsWith('blob:')) {
        plain.logo_url = null;
      }
      return plain;
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
      if (updateData.logo_url != null && typeof updateData.logo_url === 'string') {
        const raw = updateData.logo_url.trim();
        if (raw.startsWith('blob:')) {
          throw new AppError(
            'Invalid logo URL: browser preview URLs cannot be stored. Re-upload the logo from Organisation settings (the app will save a proper image).',
            400,
            'INVALID_LOGO_URL'
          );
        }
      }

      // Get existing org to merge settings and metadata
      const existingOrg = await this.orgRepo.findOne();
      
      // Merge settings if provided
      if (updateData.settings && existingOrg?.settings) {
        updateData.settings = {
          ...existingOrg.settings,
          ...updateData.settings
        };
      }
      
      // Merge metadata if provided
      if (updateData.metadata && existingOrg?.metadata) {
        updateData.metadata = {
          ...existingOrg.metadata,
          ...updateData.metadata
        };
      }

      // ACNC classification — accept either the typed top-level field or the
      // legacy metadata.acnc shape. Normalise both to the typed field so the
      // reporting pipeline has a single source of truth.
      const legacyAcnc = updateData.metadata?.acnc;
      if (legacyAcnc && !updateData.acnc_classification) {
        updateData.acnc_classification = {
          main_activity: legacyAcnc.main_activity || '',
          entity_subtypes: Array.isArray(legacyAcnc.entity_subtypes) ? legacyAcnc.entity_subtypes : [],
          charitable_purposes: Array.isArray(legacyAcnc.charitable_purposes) ? legacyAcnc.charitable_purposes : [],
          operating_states: Array.isArray(legacyAcnc.operating_states) ? legacyAcnc.operating_states : []
        };
      }
      if (updateData.acnc_classification && existingOrg?.acnc_classification) {
        updateData.acnc_classification = {
          ...existingOrg.acnc_classification.toObject?.() || existingOrg.acnc_classification,
          ...updateData.acnc_classification
        };
      }

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
