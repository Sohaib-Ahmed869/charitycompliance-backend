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
import { getMasterKeyHex } from '../config/encryption.js';
import { logError } from './logger.js';

/**
 * Mongoose plugin for transparent field encryption
 * @param {mongoose.Schema} schema - Mongoose schema
 */
export default function mongooseEncryptPlugin(schema) {
  
  // PRE-SAVE HOOK: Encrypt fields before saving (single master key for all tenants)
  schema.pre('save', function(next) {
    try {
      const keyHex = getMasterKeyHex();
      if (!keyHex || keyHex.length !== 64) {
        return next(new Error('FATAL: Master encryption key not available. Check MASTER_KEY_HEX.'));
      }

      schema.eachPath((path, schemaType) => {
        const fieldOptions = schemaType.options;
        if (fieldOptions.encrypted && this[path]) {
          const value = this[path];
          if (isEncrypted(value)) return;
          this[path] = encrypt(String(value), keyHex);
          if (fieldOptions.searchable) {
            const hashFieldName = `${path}_hash`;
            this[hashFieldName] = createBlindIndex(String(value), keyHex);
          }
        }
      });

      next();
    } catch (error) {
      next(error);
    }
  });

  // POST-FIND HOOK: Decrypt fields after fetching (single master key)
  schema.post(['find', 'findOne', 'findById', 'findOneAndUpdate', 'findOneAndDelete'], function(docs) {
    try {
      const keyHex = getMasterKeyHex();
      if (!keyHex || keyHex.length !== 64) return;

      const docList = Array.isArray(docs) ? docs : (docs ? [docs] : []);
      docList.forEach(doc => {
        if (!doc) return;
        if (doc.constructor && doc.constructor.name === 'model') {
          schema.eachPath((path, schemaType) => {
            const fieldOptions = schemaType.options;
            if (fieldOptions.encrypted && doc[path] && isEncrypted(doc[path])) {
              try {
                doc[path] = decrypt(doc[path], keyHex);
                doc.markModified(path);
              } catch (error) {
                logError('Failed to decrypt field', error, { field: path });
                doc[path] = '';
                doc.markModified(path);
              }
            }
          });
        } else {
          schema.eachPath((path, schemaType) => {
            const fieldOptions = schemaType.options;
            if (fieldOptions.encrypted && doc[path] && isEncrypted(doc[path])) {
              try {
                doc[path] = decrypt(doc[path], keyHex);
              } catch (error) {
                logError('Failed to decrypt field', error, { field: path });
                doc[path] = '';
              }
            }
          });
        }
      });
    } catch (error) {
      logError('Error in encryption plugin post-find hook', error);
    }
  });

  // POST-INIT HOOK: Decrypt when document is initialized (single master key)
  schema.post('init', function() {
    try {
      const keyHex = getMasterKeyHex();
      if (!keyHex || keyHex.length !== 64) return;
      schema.eachPath((path, schemaType) => {
        const fieldOptions = schemaType.options;
        if (fieldOptions.encrypted && this[path] && isEncrypted(this[path])) {
          try {
            this[path] = decrypt(this[path], keyHex);
          } catch (error) {
            logError('Failed to decrypt field on init', error, { field: path });
            this[path] = '';
          }
        }
      });
    } catch (error) {
      logError('Error in encryption plugin post-init hook', error);
    }
  });
}
