/**
 * File Upload Middleware
 * 
 * Handles multipart/form-data file uploads using multer
 */

import multer from 'multer';
import { AppError } from './errorHandler.js';

// Configure multer to store files in memory (we'll upload to S3)
const storage = multer.memoryStorage();

// File filter function
const fileFilter = (req, file, cb) => {
  // Allowed file types
  const allowedMimeTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif'
  ];

  const allowedExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png', '.gif'];

  // Check MIME type
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    // Check file extension as fallback
    const fileExtension = '.' + file.originalname.split('.').pop().toLowerCase();
    if (allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new AppError(
        `File type not allowed. Allowed types: ${allowedExtensions.join(', ')}`,
        400,
        'INVALID_FILE_TYPE'
      ), false);
    }
  }
};

// Configure multer
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max file size
    files: 1 // Only one file at a time
  }
});

/**
 * Middleware for single file upload
 * Attaches file to req.file
 */
export const uploadSingle = upload.single('file');

// Training resources: PDF, images, video
const trainingFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'application/pdf',
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-msvideo'
  ];
  const allowedExtensions = ['.pdf', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mov', '.avi'];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    const fileExtension = '.' + file.originalname.split('.').pop().toLowerCase();
    if (allowedExtensions.includes(fileExtension)) {
      cb(null, true);
    } else {
      cb(new AppError(
        `File type not allowed. Allowed: PDF, images, video (${allowedExtensions.join(', ')})`,
        400,
        'INVALID_FILE_TYPE'
      ), false);
    }
  }
};

const uploadTraining = multer({
  storage: storage,
  fileFilter: trainingFileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB for video
    files: 1
  }
});

/**
 * Single file upload for training resources (PDF, image, video)
 */
export const uploadTrainingSingle = uploadTraining.single('file');

// Policy documents: PNG, JPG, PDF, DOC, DOCX, PPT, PPTX up to 50MB
const policyFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ];
  const allowedExtensions = ['.jpg', '.jpeg', '.png', '.pdf', '.doc', '.docx', '.ppt', '.pptx'];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    const ext = '.' + file.originalname.split('.').pop().toLowerCase();
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new AppError(
        'File type not allowed. Allowed: PNG, JPG, PDF, DOC, DOCX, PPT, PPTX up to 50 MB',
        400,
        'INVALID_FILE_TYPE'
      ), false);
    }
  }
};

const uploadPolicy = multer({
  storage: storage,
  fileFilter: policyFileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 1
  }
});

export const uploadPolicySingle = uploadPolicy.single('file');

export const handlePolicyUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'FILE_TOO_LARGE',
          message: 'File size exceeds the maximum limit of 50MB'
        }
      });
    }
  }
  if (err) {
    return res.status(400).json({
      success: false,
      error: {
        code: err.code || 'UPLOAD_ERROR',
        message: err.message || 'File upload failed'
      }
    });
  }
  next();
};

/**
 * Middleware for multiple file uploads
 * Attaches files to req.files
 */
export const uploadMultiple = upload.array('files', 5); // Max 5 files

/**
 * Error handler for multer errors
 */
export const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'FILE_TOO_LARGE',
          message: 'File size exceeds the maximum limit of 10MB'
        }
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'TOO_MANY_FILES',
          message: 'Too many files uploaded. Maximum is 5 files.'
        }
      });
    }
    return res.status(400).json({
      success: false,
      error: {
        code: 'UPLOAD_ERROR',
        message: err.message
      }
    });
  }

  if (err) {
    return res.status(400).json({
      success: false,
      error: {
        code: err.code || 'UPLOAD_ERROR',
        message: err.message || 'File upload failed'
      }
    });
  }

  next();
};

/**
 * Error handler for training uploads (100MB limit)
 */
export const handleTrainingUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'FILE_TOO_LARGE',
          message: 'File size exceeds the maximum limit of 100MB'
        }
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'TOO_MANY_FILES',
          message: 'Too many files uploaded. Maximum is 5 files.'
        }
      });
    }
    return res.status(400).json({
      success: false,
      error: {
        code: 'UPLOAD_ERROR',
        message: err.message
      }
    });
  }
  
  if (err) {
    return res.status(400).json({
      success: false,
      error: {
        code: err.code || 'UPLOAD_ERROR',
        message: err.message || 'File upload failed'
      }
    });
  }
  
  next();
};

export default upload;
