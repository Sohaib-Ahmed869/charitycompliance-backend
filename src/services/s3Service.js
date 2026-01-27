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
      // Use process.env directly to match the working code pattern exactly
      // This avoids any potential issues with getS3Credentials() modifying the credentials
      const accessKeyId = (process.env.AWS_ACCESS_KEY_ID || '').trim();
      const secretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || '').trim();
      const region = (process.env.AWS_REGION || 'us-east-1').trim();
      const bucketName = (process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || '').trim();
      
      // Debug logging to catch issues
      console.log('=== S3 Client Initialization Debug ===');
      console.log('accessKeyId:', accessKeyId, 'length:', accessKeyId.length);
      console.log('secretAccessKey:', secretAccessKey ? `${secretAccessKey.substring(0, 4)}...${secretAccessKey.substring(secretAccessKey.length - 4)}` : 'MISSING', 'length:', secretAccessKey.length);
      console.log('region:', region);
      console.log('bucketName:', bucketName);
      console.log('=====================================');
      // Validate required credentials
      if (!accessKeyId || !secretAccessKey) {
        throw new AppError(
          'AWS credentials not configured. Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.',
          500,
          'S3_CREDENTIALS_MISSING'
        );
      }

      if (!bucketName) {
        throw new AppError(
          'S3 bucket name not configured. Please set S3_BUCKET_NAME or AWS_S3_BUCKET environment variable.',
          500,
          'S3_BUCKET_MISSING'
        );
      }
      
      // Log credential info (without exposing secrets)
      logInfo(`S3 credentials loaded - Access Key: ${accessKeyId.substring(0, 8)}...${accessKeyId.substring(accessKeyId.length - 4)}, Bucket: ${bucketName}, Configured Region: ${region}`);
      
      // Try to detect actual bucket region to avoid signature mismatches
      let actualRegion = region;
      try {
        console.log('Attempting to detect actual bucket region...');
        const detectedRegion = await getBucketRegion(bucketName, accessKeyId, secretAccessKey);
        if (detectedRegion) {
          if (detectedRegion !== region) {
            console.log(`⚠️  Region mismatch detected! Configured: ${region}, Actual: ${detectedRegion}. Using actual region.`);
            actualRegion = detectedRegion;
          } else {
            console.log(`✅ Region matches: ${detectedRegion}`);
            actualRegion = detectedRegion;
          }
        } else {
          console.log(`⚠️  Could not detect region, using configured: ${region}`);
        }
      } catch (regionError) {
        console.log(`⚠️  Region detection failed (${regionError.name}): ${regionError.message}`);
        console.log(`⚠️  Using configured region: ${region}`);
        // Continue with configured region - don't fail if detection doesn't work
      }
      
      // Create client with the correct region (detected or configured)
      s3Client = new S3Client({
        region: actualRegion,
        credentials: {
          accessKeyId: accessKeyId,
          secretAccessKey: secretAccessKey
        }
      });

      s3Config = {
        bucketName: bucketName,
        region: actualRegion
      };

      logInfo(`S3 client initialized successfully for bucket: ${bucketName} in region: ${actualRegion}`);
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
  // Create fresh client each time to match working pattern exactly
  // No caching, no region detection - just use what's in env
  const accessKeyId = (process.env.AWS_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || '').trim();
  const region = (process.env.AWS_REGION || 'us-east-1').trim();
  const bucketName = (process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || '').trim();

  if (!accessKeyId || !secretAccessKey) {
    throw new AppError('AWS credentials not configured', 500, 'S3_CREDENTIALS_MISSING');
  }

  if (!bucketName) {
    throw new AppError('S3 bucket name not configured', 500, 'S3_BUCKET_MISSING');
  }

  // Create client exactly like working code - fresh each time
  const client = new S3Client({
    region: region,
    credentials: {
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey
    }
  });

  const key = generateS3Key(orgId, category, fileName);

  console.log(`[Upload] Bucket: ${bucketName}, Region: ${region}, Key: ${key}`);

  try {
    // Minimal command - exactly like working code
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType
    });

    await client.send(command);
    console.log(`[Upload] ✅ Success!`);

    // Generate presigned URL
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key
      }),
      { expiresIn: 604800 } // 7 days
    );

    logInfo(`File uploaded to S3: ${key}`);

    return {
      key,
      url,
      bucket: bucketName,
      region: region
    };
  } catch (error) {
    logError('Error uploading file to S3:', error);
    
    // Check for region mismatch
    if (error.name === 'PermanentRedirect' || (error.message && error.message.includes('must be addressed using the specified endpoint'))) {
      // Try to extract region from error
      let detectedRegion = null;
      if (error.$metadata?.httpHeaders?.['x-amz-bucket-region']) {
        detectedRegion = error.$metadata.httpHeaders['x-amz-bucket-region'];
      } else if (error.$response?.headers?.['x-amz-bucket-region']) {
        detectedRegion = error.$response.headers['x-amz-bucket-region'];
      }
      
      if (detectedRegion && detectedRegion !== region) {
        console.log(`⚠️  Region mismatch! Trying with detected region: ${detectedRegion}`);
        // Retry with correct region
        const retryClient = new S3Client({
          region: detectedRegion,
          credentials: {
            accessKeyId: accessKeyId,
            secretAccessKey: secretAccessKey
          }
        });
        
        const retryCommand = new PutObjectCommand({
          Bucket: bucketName,
          Key: key,
          Body: fileBuffer,
          ContentType: mimeType
        });
        
        await retryClient.send(retryCommand);
        
        const url = await getSignedUrl(
          retryClient,
          new GetObjectCommand({
            Bucket: bucketName,
            Key: key
          }),
          { expiresIn: 604800 }
        );
        
        logInfo(`File uploaded to S3 (with corrected region): ${key}`);
        
        return {
          key,
          url,
          bucket: bucketName,
          region: detectedRegion
        };
      }
    }
    
    // For signature errors, provide helpful message
    if (error.name === 'SignatureDoesNotMatch') {
      throw new AppError(
        `Signature mismatch. Bucket "${bucketName}" might not be in region "${region}". Check AWS Console for actual region.`,
        500,
        'S3_UPLOAD_ERROR',
        { 
          originalError: error.message,
          errorName: error.name,
          errorCode: error.code
        }
      );
    }
    
    throw new AppError(
      `Failed to upload file to S3: ${error.message}`,
      500,
      'S3_UPLOAD_ERROR',
      { 
        originalError: error.message,
        errorName: error.name,
        errorCode: error.code
      }
    );
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
