import express from 'express';
import { body, query, param } from 'express-validator';
import { authAndResolveTenant } from '../../middleware/tenantResolver.js';
import { validate } from '../../middleware/validation.js';
import { uploadSocialCampaignImages, handleUploadError } from '../../middleware/upload.js';
import { uploadSocialCampaignImages as uploadImagesController } from '../../controllers/socialMediaUploadController.js';
import { createSocialMediaCampaign, listSocialMediaCampaigns, getSocialMediaCampaignById, updateSocialMediaCampaign } from '../../controllers/socialMediaCampaignController.js';

const router = express.Router();
router.use(authAndResolveTenant);

router.get(
  '/',
  [
    query('status').optional().isIn(['draft', 'pending', 'approved', 'rejected', 'lodged']),
    query('platform').optional().trim(),
    query('search').optional().trim()
  ],
  validate,
  listSocialMediaCampaigns
);

router.get(
  '/:campaignId',
  [param('campaignId').isMongoId().withMessage('Invalid campaign ID')],
  validate,
  getSocialMediaCampaignById
);

router.post(
  '/',
  [
    body('title').trim().notEmpty().withMessage('Campaign title is required'),
    body().custom((value, { req }) => {
      const hasPlatforms = Array.isArray(req.body?.platforms) && req.body.platforms.length > 0;
      const hasPlatform = !!String(req.body?.platform || '').trim();
      if (!hasPlatforms && !hasPlatform) throw new Error('Platform is required');
      return true;
    }),
    body('platform').optional().trim(),
    body('platforms').optional().isArray(),
    body('platforms.*').optional().isIn(['facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'youtube', 'other']),
    body('post_url').optional().trim(),
    body('post_urls').optional().isArray(),
    body('post_urls.*.platform').optional().isIn(['facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'youtube', 'other']),
    body('post_urls.*.url').optional().trim(),
    body('estimated_budget').optional().isNumeric(),
    body('ad_spend_estimate').optional().isNumeric()
  ],
  validate,
  createSocialMediaCampaign
);

router.put(
  '/:campaignId',
  [
    param('campaignId').isMongoId().withMessage('Invalid campaign ID'),
    body('title').optional().trim(),
    body('platform').optional().trim(),
    body('platforms').optional().isArray(),
    body('platforms.*').optional().isIn(['facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'youtube', 'other']),
    body('post_url').optional().trim(),
    body('post_urls').optional().isArray(),
    body('post_urls.*.platform').optional().isIn(['facebook', 'instagram', 'linkedin', 'x', 'tiktok', 'youtube', 'other']),
    body('post_urls.*.url').optional().trim(),
    body('objective').optional().trim(),
    body('estimated_budget').optional().isNumeric(),
    body('ad_spend_estimate').optional().isNumeric(),
    body('currency').optional().trim(),
    body('images').optional().isArray(),
    body('notes').optional().trim()
  ],
  validate,
  updateSocialMediaCampaign
);

router.post(
  '/upload-images',
  uploadSocialCampaignImages,
  handleUploadError,
  uploadImagesController
);

export default router;

