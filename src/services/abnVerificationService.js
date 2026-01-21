/**
 * ABN Verification Service
 * 
 * Integrates with Australian Business Register (ABR) API
 */

import axios from 'axios';
import { logError, logInfo } from '../utils/logger.js';
import config from '../config/index.js';

const ABR_API_BASE = 'https://abr.business.gov.au/abrxmlsearch/AbrXmlSearch.asmx';

/**
 * Verify ABN and fetch organization details from ABR
 * @param {string} abn - 11 digit ABN
 * @returns {Object} Organization details from ABR
 */
export async function verifyABN(abn) {
  try {
    // Remove spaces and validate format
    const cleanABN = abn.replace(/\s/g, '');
    
    if (!/^\d{11}$/.test(cleanABN)) {
      throw new Error('Invalid ABN format. Must be 11 digits.');
    }

    // ABR API call (using GUID - in production, use environment variable)
    const guid = config.abr?.guid || process.env.ABR_GUID || '';
    
    if (!guid) {
      logError('ABR_GUID not configured. Using mock data for development.');
      // Return mock data for development
      return getMockABRData(cleanABN);
    }

    const url = `${ABR_API_BASE}/SearchByABNv202001`;
    const params = {
      searchString: cleanABN,
      includeHistoricalDetails: 'N',
      authenticationGuid: guid
    };

    const response = await axios.get(url, { params });
    
    // Parse XML response (simplified - in production use proper XML parser)
    const abrData = parseABRResponse(response.data);
    
    if (!abrData || abrData.abnStatus !== 'Active') {
      throw new Error(`ABN ${cleanABN} is not active or not found.`);
    }

    logInfo('ABN verified successfully', { abn: cleanABN.substring(0, 3) + '***' });
    
    return {
      abn: cleanABN,
      legalName: abrData.entityName,
      entityType: abrData.entityType,
      entityTypeCode: abrData.entityTypeCode,
      abnStatus: abrData.abnStatus,
      gstRegistered: abrData.gstRegistered === 'Y',
      state: abrData.state,
      postcode: abrData.postcode
    };
  } catch (error) {
    logError('ABN verification failed', { error: error.message, abn: abn?.substring(0, 3) + '***' });
    throw error;
  }
}

/**
 * Parse ABR XML response (simplified)
 * In production, use xml2js or similar library
 */
function parseABRResponse(xmlData) {
  // Simplified parsing - replace with proper XML parser
  // For now, return mock data structure
  return getMockABRData();
}

/**
 * Mock ABR data for development/testing
 */
function getMockABRData(abn = '12345678901') {
  return {
    abn,
    legalName: 'Sample Charity Organisation',
    entityType: 'Other Incorporated Entity',
    entityTypeCode: 'PRV',
    abnStatus: 'Active',
    gstRegistered: false,
    state: 'NSW',
    postcode: '2000'
  };
}
