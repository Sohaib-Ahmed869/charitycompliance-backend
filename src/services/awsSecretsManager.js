/**
 * AWS Secrets Manager Service
 * 
 * Retrieves secrets from AWS Secrets Manager
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { logError, logInfo } from '../utils/logger.js';

let secretsClient = null;
let cachedSecrets = {};
const CACHE_TTL = 3600000; // 1 hour in milliseconds

/**
 * Initialize AWS Secrets Manager client
 */
function getSecretsClient() {
  if (!secretsClient) {
    secretsClient = new SecretsManagerClient({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      } : undefined // Will use IAM role if not provided
    });
  }
  return secretsClient;
}

/**
 * Get secret from AWS Secrets Manager
 * @param {string} secretName - Name of the secret in AWS Secrets Manager
 * @param {boolean} forceRefresh - Force refresh from AWS (skip cache)
 * @returns {Promise<Object>} - Parsed secret object
 */
export async function getSecret(secretName, forceRefresh = false) {
  try {
    // Check cache first
    if (!forceRefresh && cachedSecrets[secretName]) {
      const cached = cachedSecrets[secretName];
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        logInfo(`Using cached secret: ${secretName}`);
        return cached.value;
      }
    }

    const client = getSecretsClient();
    const command = new GetSecretValueCommand({
      SecretId: secretName
    });

    const response = await client.send(command);
    
    // Parse the secret (assuming JSON format)
    let secretValue;
    if (response.SecretString) {
      secretValue = JSON.parse(response.SecretString);
    } else if (response.SecretBinary) {
      secretValue = JSON.parse(Buffer.from(response.SecretBinary, 'base64').toString('utf-8'));
    } else {
      throw new Error('Secret value is empty');
    }

    // Cache the secret
    cachedSecrets[secretName] = {
      value: secretValue,
      timestamp: Date.now()
    };

    logInfo(`Successfully retrieved secret: ${secretName}`);
    return secretValue;
  } catch (error) {
    logError(`Error retrieving secret ${secretName}:`, error);
    throw error;
  }
}

/**
 * Get S3 credentials from Secrets Manager or environment variables
 * @returns {Promise<Object>} - S3 credentials object
 */
export async function getS3Credentials() {
  // First, try to get from environment variables (for development/local)
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    logInfo('Using S3 credentials from environment variables');
    // Trim whitespace from credentials to avoid signature issues
    const accessKeyId = (process.env.AWS_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || '').trim();
    const region = (process.env.AWS_REGION || 'us-east-1').trim();
    const bucketName = (process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || '').trim();
    
    return {
      accessKeyId,
      secretAccessKey,
      region,
      bucketName
    };
  }

  // If no env vars, try Secrets Manager
  const secretName = process.env.AWS_S3_SECRET_NAME || 'charity-compliance/s3-credentials';
  
  try {
    const secret = await getSecret(secretName);
    
    // Trim whitespace from credentials
    const accessKeyId = (secret.AWS_ACCESS_KEY_ID || secret.accessKeyId || process.env.AWS_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = (secret.AWS_SECRET_ACCESS_KEY || secret.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '').trim();
    const region = (secret.AWS_REGION || secret.region || process.env.AWS_REGION || 'us-east-1').trim();
    const bucketName = (secret.S3_BUCKET_NAME || secret.bucketName || process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || '').trim();
    
    return {
      accessKeyId,
      secretAccessKey,
      region,
      bucketName
    };
  } catch (error) {
    logError('Failed to get credentials from Secrets Manager, falling back to environment variables:', error);
    
    // Final fallback - return empty credentials (will fail with clear error)
    // Trim whitespace from credentials
    const accessKeyId = (process.env.AWS_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = (process.env.AWS_SECRET_ACCESS_KEY || '').trim();
    const region = (process.env.AWS_REGION || 'us-east-1').trim();
    const bucketName = (process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || '').trim();
    
    return {
      accessKeyId,
      secretAccessKey,
      region,
      bucketName
    };
  }
}

/**
 * Clear cached secrets (useful for testing or forced refresh)
 */
export function clearSecretCache() {
  cachedSecrets = {};
}
