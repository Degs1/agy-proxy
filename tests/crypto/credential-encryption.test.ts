import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
  encryptCredential,
  decryptCredential,
  reEncryptCredential,
  parseEncryptionKey,
  loadKeyStoreFromEnv,
  MissingActiveKeyError,
  MissingKeyVersionError,
  DecryptionFailedError,
  InvalidKeyFormatError,
  CredentialEncryptionError,
} from '@/lib/crypto/credential-encryption';

describe('Credential Authenticated Encryption, Tampering & Key Rotation (Requirement 3, AC 4 & AC 5 / TASK-028)', () => {
  const keyV1Hex = crypto.randomBytes(32).toString('hex');
  const keyV2Hex = crypto.randomBytes(32).toString('hex');
  const keyV3Hex = crypto.randomBytes(32).toString('hex');

  const testSecret = 'AIzaSyDemoActualGeminiApiKeySecret-9876543210';

  beforeEach(() => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEYS;
    delete process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V2;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_V3;
  });

  describe('1. Authenticated Encryption (AES-256-GCM)', () => {
    it('encrypts plaintext credential and produces valid base64 payload with version', () => {
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;

      const encrypted = encryptCredential(testSecret);

      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('iv');
      expect(encrypted).toHaveProperty('authTag');
      expect(encrypted.keyVersion).toBe(1);

      // Verify IV is 12 bytes (base64 length 16)
      const ivBuffer = Buffer.from(encrypted.iv, 'base64');
      expect(ivBuffer.length).toBe(12);

      // Verify authTag is 16 bytes (base64 length 24)
      const tagBuffer = Buffer.from(encrypted.authTag, 'base64');
      expect(tagBuffer.length).toBe(16);

      // Plaintext must not appear anywhere in the encrypted payload
      expect(encrypted.ciphertext).not.toContain(testSecret);
      expect(encrypted.iv).not.toContain(testSecret);
      expect(encrypted.authTag).not.toContain(testSecret);
    });

    it('generates a fresh, unique IV for every encryption call (no nonce reuse)', () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;

      const enc1 = encryptCredential(testSecret);
      const enc2 = encryptCredential(testSecret);
      const enc3 = encryptCredential(testSecret);

      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc2.iv).not.toBe(enc3.iv);
      expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    });

    it('successfully decrypts encrypted credential back to original plaintext', () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;

      const encrypted = encryptCredential(testSecret);
      const decrypted = decryptCredential(encrypted);

      expect(decrypted).toBe(testSecret);
    });

    it('handles arbitrary UTF-8 characters and JSON credential payloads', () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;

      const complexPayload = JSON.stringify({
        client_id: 'apps.googleusercontent.com',
        client_secret: 'sec-鍵-🔒-secret-123',
        refresh_token: '1//0gExampleRefreshTokenWithSpecialChars+==',
      });

      const encrypted = encryptCredential(complexPayload);
      const decrypted = decryptCredential(encrypted);

      expect(decrypted).toBe(complexPayload);
    });

    it('rejects empty or non-string plaintext with CredentialEncryptionError', () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;

      expect(() => encryptCredential('')).toThrow(CredentialEncryptionError);
      // @ts-expect-error testing invalid type
      expect(() => encryptCredential(null)).toThrow(CredentialEncryptionError);
    });
  });

  describe('2. Key Formats & Parsing', () => {
    it('accepts 64-character hex keys', () => {
      const hexKey = crypto.randomBytes(32).toString('hex');
      const buf = parseEncryptionKey(hexKey);
      expect(buf.length).toBe(32);
    });

    it('accepts 44-character base64 keys', () => {
      const b64Key = crypto.randomBytes(32).toString('base64');
      const buf = parseEncryptionKey(b64Key);
      expect(buf.length).toBe(32);
    });

    it('accepts 32-byte raw ASCII/UTF-8 strings', () => {
      const raw32 = '12345678901234567890123456789012';
      const buf = parseEncryptionKey(raw32);
      expect(buf.length).toBe(32);
    });

    it('rejects keys that are not 32 bytes (too short or too long)', () => {
      expect(() => parseEncryptionKey('too_short_key')).toThrow(InvalidKeyFormatError);
      expect(() => parseEncryptionKey('a'.repeat(63))).toThrow(InvalidKeyFormatError);
      expect(() => parseEncryptionKey('a'.repeat(65))).toThrow(InvalidKeyFormatError);
    });
  });

  describe('3. Missing Key & Safe Failure', () => {
    it('throws MissingActiveKeyError when active key version is not configured', () => {
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '2';
      // Only V1 is defined
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;

      expect(() => encryptCredential(testSecret)).toThrow(MissingActiveKeyError);
    });

    it('throws MissingKeyVersionError when decrypting payload whose key version is missing', () => {
      // Encrypt with V1
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
      const encrypted = encryptCredential(testSecret);

      // Now remove V1 key from env and only set V2
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1;
      process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = keyV2Hex;

      expect(() => decryptCredential(encrypted)).toThrow(MissingKeyVersionError);
    });

    it('never returns fallback plaintext or leaks secrets on missing key', () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
      const encrypted = encryptCredential(testSecret);

      delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1;

      let result: string | null = null;
      let errorThrown: unknown = null;
      try {
        result = decryptCredential(encrypted);
      } catch (e) {
        errorThrown = e;
      }

      expect(result).toBeNull();
      expect(errorThrown).toBeInstanceOf(MissingKeyVersionError);
      // Ensure error message does not leak the secret
      expect((errorThrown as Error).message).not.toContain(testSecret);
    });
  });

  describe('4. Wrong Key & Tampered Ciphertext Verification', () => {
    it('throws DecryptionFailedError when key bytes do not match original encryption key', () => {
      // Encrypt with Key V1
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
      const encrypted = encryptCredential(testSecret);

      // Now change Key V1 to a completely different 32-byte key
      const differentKeyHex = crypto.randomBytes(32).toString('hex');
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = differentKeyHex;

      expect(() => decryptCredential(encrypted)).toThrow(DecryptionFailedError);
    });

    it('throws DecryptionFailedError when ciphertext is tampered with (bit flip)', () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
      const encrypted = encryptCredential(testSecret);

      // Corrupt ciphertext buffer
      const cipherBuf = Buffer.from(encrypted.ciphertext, 'base64');
      cipherBuf[0] ^= 0x01; // flip 1 bit
      const tampered = {
        ...encrypted,
        ciphertext: cipherBuf.toString('base64'),
      };

      expect(() => decryptCredential(tampered)).toThrow(DecryptionFailedError);
    });

    it('throws DecryptionFailedError when IV / nonce is tampered with', () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
      const encrypted = encryptCredential(testSecret);

      const ivBuf = Buffer.from(encrypted.iv, 'base64');
      ivBuf[0] ^= 0xff;
      const tampered = {
        ...encrypted,
        iv: ivBuf.toString('base64'),
      };

      expect(() => decryptCredential(tampered)).toThrow(DecryptionFailedError);
    });

    it('throws DecryptionFailedError when authentication tag is tampered with', () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
      const encrypted = encryptCredential(testSecret);

      const tagBuf = Buffer.from(encrypted.authTag, 'base64');
      tagBuf[tagBuf.length - 1] ^= 0xaa;
      const tampered = {
        ...encrypted,
        authTag: tagBuf.toString('base64'),
      };

      expect(() => decryptCredential(tampered)).toThrow(DecryptionFailedError);
    });

    it('throws DecryptionFailedError when IV or authTag has invalid length', () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
      const encrypted = encryptCredential(testSecret);

      const invalidIv = {
        ...encrypted,
        iv: Buffer.from('short_iv').toString('base64'),
      };
      expect(() => decryptCredential(invalidIv)).toThrow(DecryptionFailedError);

      const invalidTag = {
        ...encrypted,
        authTag: Buffer.from('short_tag').toString('base64'),
      };
      expect(() => decryptCredential(invalidTag)).toThrow(DecryptionFailedError);
    });
  });

  describe('5. Key Rotation & Migration (Requirement 3, AC 5)', () => {
    it('maintains backwards compatibility: old credentials encrypted with V1 remain readable after V2 becomes active', () => {
      // Step 1: Encrypt with V1
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
      const credV1 = encryptCredential(testSecret);
      expect(credV1.keyVersion).toBe(1);

      // Step 2: Introduce Key V2 and make V2 active
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '2';
      process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = keyV2Hex;

      // New credential uses V2
      const newSecret = 'AIzaSyNewGeminiKeyV2-12345';
      const credV2 = encryptCredential(newSecret);
      expect(credV2.keyVersion).toBe(2);

      // Old credential encrypted with V1 MUST still decrypt cleanly
      const decryptedOld = decryptCredential(credV1);
      expect(decryptedOld).toBe(testSecret);

      // New credential encrypted with V2 decrypts cleanly
      const decryptedNew = decryptCredential(credV2);
      expect(decryptedNew).toBe(newSecret);
    });

    it('migrates a V1 credential to V2 and verifies round-trip decryption', () => {
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '1';
      process.env.CREDENTIAL_ENCRYPTION_KEY_V1 = keyV1Hex;
      const credV1 = encryptCredential(testSecret);

      // Set active key to V2
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '2';
      process.env.CREDENTIAL_ENCRYPTION_KEY_V2 = keyV2Hex;

      // Run re-encryption migration
      const migratedCred = reEncryptCredential(credV1);

      expect(migratedCred.keyVersion).toBe(2);
      expect(migratedCred.ciphertext).not.toBe(credV1.ciphertext);
      expect(migratedCred.iv).not.toBe(credV1.iv);

      // Verify the migrated credential decrypts to original plaintext
      const decryptedMigrated = decryptCredential(migratedCred);
      expect(decryptedMigrated).toBe(testSecret);

      // After migration, if V1 is retired (removed from environment), V2 credential still works!
      delete process.env.CREDENTIAL_ENCRYPTION_KEY_V1;
      expect(decryptCredential(migratedCred)).toBe(testSecret);

      // But trying to read unmigrated V1 credential now safely throws MissingKeyVersionError
      expect(() => decryptCredential(credV1)).toThrow(MissingKeyVersionError);
    });

    it('supports key rotation via CREDENTIAL_ENCRYPTION_KEYS JSON map', () => {
      process.env.CREDENTIAL_ENCRYPTION_ACTIVE_VERSION = '2';
      process.env.CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({
        '1': keyV1Hex,
        '2': keyV2Hex,
        '3': keyV3Hex,
      });

      const encrypted = encryptCredential(testSecret);
      expect(encrypted.keyVersion).toBe(2);
      expect(decryptCredential(encrypted)).toBe(testSecret);

      // Can explicitly encrypt with V1 or V3
      const encV1 = encryptCredential(testSecret, { version: 1 });
      expect(encV1.keyVersion).toBe(1);
      expect(decryptCredential(encV1)).toBe(testSecret);

      const encV3 = encryptCredential(testSecret, { version: 3 });
      expect(encV3.keyVersion).toBe(3);
      expect(decryptCredential(encV3)).toBe(testSecret);
    });
  });
});
