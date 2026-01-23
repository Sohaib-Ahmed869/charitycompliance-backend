/**
 * AWS S3 Service
 * 
 * Handles file uploads, downloads, and deletions from S3
 */

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getS3Credentials } from './awsSecretsManager.js';
import { logError, logInfo } from '../utils/logger.js';
import { AppError } from '../middleware/errorHandler.js';
import crypto from 'crypto';

let s3Client = null;
let s3Config = null;

/**
 * Clear cached S3 client (useful for testing or when credentials change)
 */
export function clearS3ClientCache() {
  s3Client = null;
  s3Config = null;
  logInfo('S3 client cache cleared');
}

/**
 * Get the actual region of an S3 bucket
 * Note: GetBucketLocationCommand must be called with us-east-1 region
 * @param {string} bucketName - Bucket name
 * @param {string} accessKeyId - AWS access key
 * @param {string} secretAccessKey - AWS secret key
 * @returns {Promise<string|null>} - Bucket region or null if detection fails
 */
async function getBucketRegion(bucketName, accessKeyId, secretAccessKey) {
  try {
    // GetBucketLocationCommand must be called with us-east-1 region
    const locationClient = new S3Client({
      region: 'us-east-1',
      credentials: {
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey
      }
    });

    const command = new GetBucketLocationCommand({ Bucket: bucketName });
    const response = await locationClient.send(command);
    
    // AWS returns null or empty string for us-east-1, actual region name for others
    let region = response.LocationConstraint;
    
    // Handle different response formats
    if (!region || region === '' || region === null) {
      region = 'us-east-1'; // Default region
    }
    
    logInfo(`Detected bucket region: ${region}`);
    return region;
  } catch (error) {
    logError('Error getting bucket region (will use configured region):', error);
    // If we can't get the region, return null and let the configured region be used
    return null;
  }
}

/**
 * Initialize S3 client with credentials from Secrets Manager or environment variables
 */
async function getS3Client() {
  if (!s3Client || !s3Config) {
    try {
      const credentials = await getS3Credentials();
      
      // Validate required credentials
      if (!credentials.accessKeyId || !credentials.secretAccessKey) {
        throw new AppError(
          'AWS credentials not configured. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables or configure Secrets Manager.',
          500,
          'S3_CREDENTIALS_MISSING'
        );
      }

      if (!credentials.bucketName) {
        throw new AppError(
          'S3 bucket name not configured. Please set S3_BUCKET_NAME environment variable or configure in Secrets Manager.',
          500,
          'S3_BUCKET_MISSING'
        );
      }
      
      // Create initial client with configured region
      const configuredRegion = (credentials.region || 'us-east-1').toLowerCase().trim();
      
      // Try to get the actual bucket region first
      const actualRegion = await getBucketRegion(
        credentials.bucketName,
        credentials.accessKeyId,
        credentials.secretAccessKey
      );
      
      // Use actual region if detected, otherwise use configured region
      const finalRegion = actualRegion ? actualRegion.toLowerCase().trim() : configuredRegion;
      
      // Log if there's a mismatch
      if (actualRegion && actualRegion.toLowerCase().trim() !== configuredRegion) {
        logInfo(`Bucket region mismatch detected. Configured: ${configuredRegion}, Actual: ${actualRegion}. Using actual region: ${finalRegion}`);
      } else if (!actualRegion) {
        logInfo(`Using configured region: ${finalRegion} (could not detect bucket region)`);
      } else {
        logInfo(`Region matches: ${finalRegion}`);
      }
      
      // Create client with the correct region
      s3Client = new S3Client({
        region: finalRegion,
        credentials: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey
        }
      });

      s3Config = {
        bucketName: credentials.bucketName,
        region: finalRegion
      };

      logInfo(`S3 client initialized successfully for bucket: ${credentials.bucketName} in region: ${s3Config.region}`);
    } catch (error) {
      logError('Error initializing S3 client:', error);
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        `Failed to initialize S3 service: ${error.message}`,
        500,
        'S3_INIT_ERROR'
      );
    }
  }
  return { client: s3Client, config: s3Config };
}

/**
 * Generate a unique file key for S3
 * @param {string} orgId - Organization identifier
 * @param {string} category - Document category
 * @param {string} originalFileName - Original file name
 * @returns {string} - Unique S3 key
 */
function generateS3Key(orgId, category, originalFileName) {
  const timestamp = Date.now();
  const randomString = crypto.randomBytes(8).toString('hex');
  const fileExtension = originalFileName.split('.').pop();
  const sanitizedFileName = originalFileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  
  return `${orgId}/${category}/${timestamp}-${randomString}-${sanitizedFileName}`;
}

/**
 * Upload file to S3
 * @param {Buffer} fileBuffer - File buffer
 * @param {string} fileName - Original file name
 * @param {string} mimeType - File MIME type
 * @param {string} orgId - Organization identifier
 * @param {string} category - Document category
 * @returns {Promise<Object>} - Upload result with key and URL
 */
export async function uploadToS3(fileBuffer, fileName, mimeType, orgId, category) {
  let config = null;
  let retryCount = 0;
  const maxRetries = 1; // Only retry once for region mismatch
  
  while (retryCount <= maxRetries) {
    try {
      const { client, config: s3Config } = await getS3Client();
      config = s3Config; // Store config for error handling
    
    if (!config.bucketName) {
      throw new AppError('S3 bucket name not configured', 500, 'S3_CONFIG_ERROR');
    }

    const key = generateS3Key(orgId, category, fileName);

    const command = new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
      Metadata: {
        'original-filename': fileName,
        'org-id': orgId,
        'category': category,
        'uploaded-at': new Date().toISOString()
      }
    });

    await client.send(command);

    // Generate presigned URL for access (valid for 7 days)
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: config.bucketName,
        Key: key
      }),
      { expiresIn: 604800 } // 7 days
    );

    logInfo(`File uploaded to S3: ${key}`);

      return {
        key,
        url,
        bucket: config.bucketName,
        region: config.region
      };
    } catch (error) {
      logError('Error uploading file to S3:', error);
      
      // Check if this is a region mismatch error (PermanentRedirect) and we haven't retried yet
      const isRegionMismatch = error.name === 'PermanentRedirect' || 
                               (error.message && error.message.includes('must be addressed using the specified endpoint'));
      
      if (isRegionMismatch && retryCount < maxRetries) {
        logInfo('Region mismatch detected during upload. Attempting to extract correct region from error...');
        
        // Try to extract region from PermanentRedirect error
        let detectedRegion = null;
        
        // Method 1: Check error metadata headers
        if (error.$metadata?.httpHeaders?.['x-amz-bucket-region']) {
          detectedRegion = error.$metadata.httpHeaders['x-amz-bucket-region'];
        } else if (error.$response?.headers?.['x-amz-bucket-region']) {
          detectedRegion = error.$response.headers['x-amz-bucket-region'];
        }
        
        // Method 2: Try to parse from endpoint URL in error message
        if (!detectedRegion && error.message) {
          const endpointMatch = error.message.match(/https?:\/\/([^.]+)\.s3\.([^.]+)\.amazonaws\.com/);
          if (endpointMatch && endpointMatch[2]) {
            detectedRegion = endpointMatch[2];
          }
        }
        
        if (detectedRegion) {
          logInfo(`Extracted region from PermanentRedirect: ${detectedRegion}. Updating client and retrying...`);
          clearS3ClientCache();
          
          // Update credentials with detected region and recreate client
          const credentials = await getS3Credentials();
          s3Client = new S3Client({
            region: detectedRegion,
            credentials: {
              accessKeyId: credentials.accessKeyId,
              secretAccessKey: credentials.secretAccessKey
            }
          });
          
          s3Config = {
            bucketName: credentials.bucketName,
            region: detectedRegion
          };
          
          retryCount++;
          continue; // Retry the upload with correct region
        } else {
          logInfo('Could not extract region from error. Clearing cache and retrying...');
          clearS3ClientCache();
          retryCount++;
          continue; // Retry anyway (might work if region detection succeeds this time)
        }
      }
      
      // Extract meaningful error message
      let errorMessage = 'Failed to upload file to S3';
      if (error.message) {
        errorMessage += `: ${error.message}`;
      }
      
      // Get bucket name and region for error messages (try to get from config or env)
      const bucketName = config?.bucketName || process.env.S3_BUCKET_NAME || 'unknown';
      const region = config?.region || process.env.AWS_REGION || 'unknown';
      
      // Check for specific AWS errors
      if (error.name === 'CredentialsProviderError' || error.code === 'CredentialsError') {
        errorMessage = 'AWS credentials are invalid or missing. Please check your AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.';
      } else if (error.name === 'NoSuchBucket' || error.code === 'NoSuchBucket') {
        errorMessage = `S3 bucket "${bucketName}" does not exist. Please check your S3_BUCKET_NAME configuration.`;
      } else if (error.name === 'AccessDenied' || error.code === 'AccessDenied') {
        errorMessage = 'Access denied to S3 bucket. Please check your AWS IAM permissions.';
      } else if (error.name === 'InvalidAccessKeyId') {
        errorMessage = 'Invalid AWS access key ID. Please check your AWS_ACCESS_KEY_ID.';
      } else if (error.name === 'SignatureDoesNotMatch') {
        errorMessage = 'Invalid AWS secret access key. Please check your AWS_SECRET_ACCESS_KEY.';
      } else if (error.name === 'PermanentRedirect' || (error.message && error.message.includes('must be addressed using the specified endpoint'))) {
        // PermanentRedirect error - provide helpful error message
        // (Region extraction and retry already handled above)
        errorMessage = `S3 region mismatch! Your bucket is in a different region than "${region}". Please check your bucket's region in the AWS S3 Console and update AWS_REGION accordingly. Note: Your IAM user needs s3:GetBucketLocation permission for automatic region detection.`;
      }
      
      throw new AppError(
        errorMessage,
        500,
        'S3_UPLOAD_ERROR',
        { 
          originalError: error.message,
          errorName: error.name,
          errorCode: error.code,
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }
      );
    }
  }
}

/**
 * Get presigned URL for file download
 * @param {string} s3Key - S3 object key
 * @param {number} expiresIn - URL expiration time in seconds (default: 1 hour)
 * @returns {Promise<string>} - Presigned URL
 */
export async function getFileUrl(s3Key, expiresIn = 3600) {
  try {
    const { client, config } = await getS3Client();
    
    if (!config.bucketName) {
      throw new AppError('S3 bucket name not configured', 500, 'S3_CONFIG_ERROR');
    }

    const command = new GetObjectCommand({
      Bucket: config.bucketName,
      Key: s3Key
    });

    const url = await getSignedUrl(client, command, { expiresIn });
    return url;
  } catch (error) {
    logError('Error generating file URL:', error);
    throw new AppError('Failed to generate file URL', 500, 'S3_URL_ERROR');
  }
}

/**
 * Delete file from S3
 * @param {string} s3Key - S3 object key
 * @returns {Promise<void>}
 */
export async function deleteFromS3(s3Key) {
  try {
    const { client, config } = await getS3Client();
    
    if (!config.bucketName) {
      throw new AppError('S3 bucket name not configured', 500, 'S3_CONFIG_ERROR');
    }

    const command = new DeleteObjectCommand({
      Bucket: config.bucketName,
      Key: s3Key
    });

    await client.send(command);
    logInfo(`File deleted from S3: ${s3Key}`);
  } catch (error) {
    logError('Error deleting file from S3:', error);
    throw new AppError('Failed to delete file from S3', 500, 'S3_DELETE_ERROR');
  }
}

/**
 * Check if file exists in S3
 * @param {string} s3Key - S3 object key
 * @returns {Promise<boolean>}
 */
export async function fileExistsInS3(s3Key) {
  try {
    const { client, config } = await getS3Client();
    
    if (!config.bucketName) {
      return false;
    }

    const command = new HeadObjectCommand({
      Bucket: config.bucketName,
      Key: s3Key
    });

    await client.send(command);
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    logError('Error checking file existence in S3:', error);
    return false;
  }
}
