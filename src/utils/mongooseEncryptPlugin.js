/**
 * Mongoose Encryption Plugin
 * 
 * Transparent encryption plugin for Mongoose schemas.
 * Automatically encrypts fields marked with { encrypted: true } on save,
 * and decrypts them on find operations.
 * 
 * Usage:
 *   const UserSchema = new Schema({
 *     email: { type: String, encrypted: true, searchable: true }
 *   });
 *   UserSchema.plugin(require('./mongooseEncryptPlugin'));
 */

import { encrypt, decrypt, createBlindIndex, isEncrypted } from './encryption.js';
import { logError } from './logger.js';
import crypto from 'crypto';
import config from '../config/index.js';

/**
 * Mongoose plugin for transparent field encryption
 * @param {mongoose.Schema} schema - Mongoose schema
 */
export default function mongooseEncryptPlugin(schema) {
  
  // PRE-SAVE HOOK: Encrypt fields before saving
  schema.pre('save', function(next) {
    try {
      // Get the organization key from the database connection context
      // This is set by the connection manager
      const db = this.constructor.db;
      
      if (!db || !db.config || !db.config.orgKey) {
        return next(new Error('FATAL: No encryption key found in database context. Ensure tenantResolver middleware is applied.'));
      }

      const orgKey = db.config.orgKey;

      // Iterate through all schema paths
      schema.eachPath((path, schemaType) => {
        const fieldOptions = schemaType.options;
        
        // Check if field is marked for encryption
        if (fieldOptions.encrypted && this[path]) {
          const value = this[path];
          
          // Skip if already encrypted (prevents double encryption)
          if (isEncrypted(value)) {
            return;
          }

          // Encrypt the field value
          this[path] = encrypt(String(value), orgKey);

          // If field is searchable, create blind index hash
          if (fieldOptions.searchable) {
            const hashFieldName = `${path}_hash`;
            // Email hash must use master key for cross-tenant search
            // Other searchable fields use orgKey for tenant-specific isolation
            const hashKey = path === 'email' ? config.encryption.masterKeyHex : orgKey;
            
            if (!hashKey || hashKey.length !== 64) {
              return next(new Error(`FATAL: Invalid hash key for field ${path}. Key length: ${hashKey?.length || 0}`));
            }
            
            this[hashFieldName] = createBlindIndex(String(value), hashKey);
          }
        }
      });

      next();
    } catch (error) {
      next(error);
    }
  });

  // POST-FIND HOOK: Decrypt fields after fetching
  schema.post(['find', 'findOne', 'findById', 'findOneAndUpdate', 'findOneAndDelete'], function(docs) {
    try {
      // Handle single document or array of documents
      const docList = Array.isArray(docs) ? docs : (docs ? [docs] : []);
      
      const db = this.model.db;
      if (!db || !db.config || !db.config.orgKey) {
        // No key available, skip decryption (might be router DB query)
        return;
      }

      const orgKey = db.config.orgKey;

      docList.forEach(doc => {
        if (!doc) return;

        // Ensure document is a mongoose document (not plain object)
        if (doc.constructor && doc.constructor.name === 'model') {
          // Mongoose document - decrypt in place
          schema.eachPath((path, schemaType) => {
            const fieldOptions = schemaType.options;
            
            if (fieldOptions.encrypted && doc[path] && isEncrypted(doc[path])) {
              try {
                doc[path] = decrypt(doc[path], orgKey);
                // Mark as modified to ensure changes persist
                doc.markModified(path);
              } catch (error) {
                logError('Failed to decrypt field', error, { field: path });
              }
            }
          });
        } else {
          // Plain object - decrypt directly
          schema.eachPath((path, schemaType) => {
            const fieldOptions = schemaType.options;
            
            if (fieldOptions.encrypted && doc[path] && isEncrypted(doc[path])) {
              try {
                doc[path] = decrypt(doc[path], orgKey);
              } catch (error) {
                logError('Failed to decrypt field', error, { field: path });
              }
            }
          });
        }
      });
    } catch (error) {
      logError('Error in encryption plugin post-find hook', error);
    }
  });

  // POST-INIT HOOK: Decrypt fields when document is initialized (e.g., from JSON)
  schema.post('init', function() {
    try {
      const db = this.constructor.db;
      if (!db || !db.config || !db.config.orgKey) {
        return;
      }

      const orgKey = db.config.orgKey;

      schema.eachPath((path, schemaType) => {
        const fieldOptions = schemaType.options;
        
        if (fieldOptions.encrypted && this[path] && isEncrypted(this[path])) {
          try {
            this[path] = decrypt(this[path], orgKey);
          } catch (error) {
            logError('Failed to decrypt field on init', error, { field: path });
          }
        }
      });
    } catch (error) {
      logError('Error in encryption plugin post-init hook', error);
    }
  });
}
