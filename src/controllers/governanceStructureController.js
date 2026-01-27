/**
 * Governance Structure Controller
 *
 * Handles HTTP requests for governance structure
 */

import { getTenantConnection } from '../db/connectionManager.js';
import { GovernanceStructureRepository } from '../repositories/governanceStructureRepository.js';
import { OrganizationRepository } from '../repositories/organizationRepository.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AppError } from '../middleware/errorHandler.js';
import { logInfo, logError } from '../utils/logger.js';
import { uploadToS3, getFileUrl } from '../services/s3Service.js';
import multer from 'multer';

// Configure multer for multiple file fields
const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10 MB
  },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/jpg',
      'image/png'
    ];
    
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      const fileExtension = '.' + file.originalname.split('.').pop().toLowerCase();
      const allowedExtensions = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png'];
      if (allowedExtensions.includes(fileExtension)) {
        cb(null, true);
      } else {
        cb(new AppError('Invalid file type. Only PDF, DOC, DOCX, PNG, JPG are allowed.', 400, 'INVALID_FILE_TYPE'), false);
      }
    }
  }
});

export const uploadFiles = upload.fields([
  { name: 'conflict_of_interest_policy', maxCount: 1 },
  { name: 'financial_management_policies', maxCount: 1 }
]);

export const getGovernanceStructure = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const governanceStructureRepo = new GovernanceStructureRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);
  
  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const governanceStructure = await governanceStructureRepo.findByOrgId(org._id);

  // Generate presigned URLs for existing files
  if (governanceStructure) {
    const structureWithUrls = { ...governanceStructure.toObject() };
    
    // Generate URL for conflict of interest policy
    if (structureWithUrls.conflict_of_interest_policy_url) {
      try {
        structureWithUrls.conflict_of_interest_policy_file_url = await getFileUrl(structureWithUrls.conflict_of_interest_policy_url);
      } catch (error) {
        logError('Error generating conflict policy URL:', error);
        structureWithUrls.conflict_of_interest_policy_file_url = null;
      }
    }
    
    // Generate URL for financial management policies
    if (structureWithUrls.financial_management_policies_url) {
      try {
        structureWithUrls.financial_management_policies_file_url = await getFileUrl(structureWithUrls.financial_management_policies_url);
      } catch (error) {
        logError('Error generating financial policies URL:', error);
        structureWithUrls.financial_management_policies_file_url = null;
      }
    }

    res.json({
      success: true,
      data: structureWithUrls
    });
  } else {
    res.json({
      success: true,
      data: null
    });
  }
});

export const updateGovernanceStructure = asyncHandler(async (req, res) => {
  const orgId = req.orgId;
  const tenantDb = await getTenantConnection(orgId);
  const governanceStructureRepo = new GovernanceStructureRepository(tenantDb);
  const orgRepo = new OrganizationRepository(tenantDb);

  const org = await orgRepo.findOne();
  if (!org) {
    throw new AppError('Organization not found', 404, 'ORG_NOT_FOUND');
  }

  const updateData = {
    org_id: org._id,
    conflict_of_interest_clause: req.body.conflict_of_interest_clause,
    conflict_management_explanation: req.body.conflict_management_explanation,
    works_with_vulnerable_people: req.body.works_with_vulnerable_people,
    safeguarding_details: req.body.safeguarding_details || null,
    financial_governance_explanation: req.body.financial_governance_explanation || null,
    third_party_controls: req.body.third_party_controls,
    accountability_explanation: req.body.accountability_explanation,
    member_concerns_process: req.body.member_concerns_process,
    is_basic_religious_charity: req.body.is_basic_religious_charity
  };

  // Handle file uploads to S3
  if (req.files) {
    if (req.files.conflict_of_interest_policy && req.files.conflict_of_interest_policy[0]) {
      const file = req.files.conflict_of_interest_policy[0];
      const { key } = await uploadToS3(
        file.buffer,
        file.originalname,
        file.mimetype,
        orgId,
        'governance'
      );
      updateData.conflict_of_interest_policy_url = key;
    }
    if (req.files.financial_management_policies && req.files.financial_management_policies[0]) {
      const file = req.files.financial_management_policies[0];
      const { key } = await uploadToS3(
        file.buffer,
        file.originalname,
        file.mimetype,
        orgId,
        'governance'
      );
      updateData.financial_management_policies_url = key;
    }
  }

  // Remove undefined fields
  Object.keys(updateData).forEach(key => 
    updateData[key] === undefined && delete updateData[key]
  );

  const governanceStructure = await governanceStructureRepo.update(org._id, updateData);

  logInfo('Governance structure updated', { orgId });

  res.json({
    success: true,
    data: governanceStructure
  });
});
