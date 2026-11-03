import { describe, it, expect } from 'vitest';
import {
  createAnonymousCsrf,
  verifyAnonymousCsrf,
  verifyMutationOrigin,
  verifyCsrfOriginEvidence,
  generateRandomToken,
  hashToken,
  timingSafeEqualString,
} from '@/lib/auth/csrf';

describe('CSRF Token & Origin Verification (Requirement 2, AC 2)', () => {
  const APP_ORIGIN = 'http://localhost:3000';

  describe('Anonymous Pre-Session CSRF Binding', () => {
    it('creates and verifies a valid anonymous CSRF token and signed cookie pair', () => {
      const pair = createAnonymousCsrf();
      expect(pair.token).toBeDefined();
      expect(pair.cookieValue).toBeDefined();
      expect(pair.maxAge).toBe(15 * 60);

      const isValid = verifyAnonymousCsrf(pair.token, pair.cookieValue);
      expect(isValid).toBe(true);
    });

    it('rejects an invalid or mismatched token against a signed cookie', () => {
      const pair = createAnonymousCsrf();
      const fakeToken = generateRandomToken(32);

      const isValid = verifyAnonymousCsrf(fakeToken, pair.cookieValue);
      expect(isValid).toBe(false);
    });

    it('rejects a tampered signed cookie', () => {
      const pair = createAnonymousCsrf();
      const parts = pair.cookieValue.split('.');
      // Tamper signature
      const tamperedCookie = `${parts[0]}.${parts[1]}.tampered_signature_hex`;

      const isValid = verifyAnonymousCsrf(pair.token, tamperedCookie);
      expect(isValid).toBe(false);
    });

    it('rejects an expired anonymous signed cookie', () => {
      const authSecret = 'test_secret_for_expiration_check_32bytes!';
      const token = generateRandomToken(32);
      const tokenHash = hashToken(token);
      // Expired 1 second ago
      const expiredTimestamp = Date.now() - 1000;
      const signature = require('crypto')
        .createHmac('sha256', authSecret)
        .update(`${tokenHash}:${expiredTimestamp}`)
        .digest('hex');

      const expiredCookie = `${tokenHash}.${expiredTimestamp}.${signature}`;
      const isValid = verifyAnonymousCsrf(token, expiredCookie, authSecret);
      expect(isValid).toBe(false);
    });

    it('rejects empty, null, or undefined tokens and cookies', () => {
      expect(verifyAnonymousCsrf(null, 'abc')).toBe(false);
      expect(verifyAnonymousCsrf('token', null)).toBe(false);
      expect(verifyAnonymousCsrf('', '')).toBe(false);
      expect(verifyAnonymousCsrf('token', 'malformed_cookie_no_dots')).toBe(false);
    });
  });

  describe('Mutation Origin Verification', () => {
    it('accepts matching Origin header exactly', () => {
      const req = new Request('http://localhost:3000/api/admin/bootstrap', {
        method: 'POST',
        headers: { origin: 'http://localhost:3000' },
      });
      const check = verifyMutationOrigin(req, APP_ORIGIN);
      expect(check.valid).toBe(true);
    });

    it('rejects missing Origin header on mutation', () => {
      const req = new Request('http://localhost:3000/api/admin/bootstrap', {
        method: 'POST',
      });
      const check = verifyMutationOrigin(req, APP_ORIGIN);
      expect(check.valid).toBe(false);
      expect(check.reason).toContain('Origin header is required');
    });

    it('rejects mismatched Origin header', () => {
      const req = new Request('http://localhost:3000/api/admin/bootstrap', {
        method: 'POST',
        headers: { origin: 'https://evil-attacker.com' },
      });
      const check = verifyMutationOrigin(req, APP_ORIGIN);
      expect(check.valid).toBe(false);
      expect(check.reason).toContain('Origin mismatch');
    });

    it('rejects Origin: null', () => {
      const req = new Request('http://localhost:3000/api/admin/bootstrap', {
        method: 'POST',
        headers: { origin: 'null' },
      });
      const check = verifyMutationOrigin(req, APP_ORIGIN);
      expect(check.valid).toBe(false);
      expect(check.reason).toContain('null');
    });
  });

  describe('GET /api/admin/csrf Origin Evidence Verification', () => {
    it('accepts exact Origin when present', () => {
      const req = new Request('http://localhost:3000/api/admin/csrf', {
        headers: { origin: 'http://localhost:3000' },
      });
      const check = verifyCsrfOriginEvidence(req, APP_ORIGIN);
      expect(check.valid).toBe(true);
    });

    it('rejects mismatched Origin when present', () => {
      const req = new Request('http://localhost:3000/api/admin/csrf', {
        headers: { origin: 'https://evil.com' },
      });
      const check = verifyCsrfOriginEvidence(req, APP_ORIGIN);
      expect(check.valid).toBe(false);
      expect(check.reason).toContain('Origin mismatch');
    });

    it('accepts Sec-Fetch-Site: same-origin when Origin is omitted', () => {
      const req = new Request('http://localhost:3000/api/admin/csrf', {
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      const check = verifyCsrfOriginEvidence(req, APP_ORIGIN);
      expect(check.valid).toBe(true);
    });

    it('rejects Sec-Fetch-Site: cross-site or same-site', () => {
      const crossSiteReq = new Request('http://localhost:3000/api/admin/csrf', {
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(verifyCsrfOriginEvidence(crossSiteReq, APP_ORIGIN).valid).toBe(false);

      const sameSiteReq = new Request('http://localhost:3000/api/admin/csrf', {
        headers: { 'sec-fetch-site': 'same-site' },
      });
      expect(verifyCsrfOriginEvidence(sameSiteReq, APP_ORIGIN).valid).toBe(false);
    });

    it('accepts Referer matching application origin when Origin and Sec-Fetch-Site are absent', () => {
      const req = new Request('http://localhost:3000/api/admin/csrf', {
        headers: { referer: 'http://localhost:3000/dashboard' },
      });
      const check = verifyCsrfOriginEvidence(req, APP_ORIGIN);
      expect(check.valid).toBe(true);
    });

    it('rejects Referer from different origin', () => {
      const req = new Request('http://localhost:3000/api/admin/csrf', {
        headers: { referer: 'https://attacker.site/phish' },
      });
      const check = verifyCsrfOriginEvidence(req, APP_ORIGIN);
      expect(check.valid).toBe(false);
    });

    it('rejects conflicting origin headers (Origin vs Referer)', () => {
      const req = new Request('http://localhost:3000/api/admin/csrf', {
        headers: {
          origin: 'http://localhost:3000',
          referer: 'https://other-domain.com/page',
        },
      });
      const check = verifyCsrfOriginEvidence(req, APP_ORIGIN);
      expect(check.valid).toBe(false);
      expect(check.reason).toContain('conflict');
    });

    it('rejects request with no origin evidence at all', () => {
      const req = new Request('http://localhost:3000/api/admin/csrf');
      const check = verifyCsrfOriginEvidence(req, APP_ORIGIN);
      expect(check.valid).toBe(false);
      expect(check.reason).toContain('No valid origin evidence');
    });
  });

  describe('Timing-safe string comparison', () => {
    it('returns true for identical strings', () => {
      expect(timingSafeEqualString('secret_token_123', 'secret_token_123')).toBe(true);
    });

    it('returns false for different lengths or characters', () => {
      expect(timingSafeEqualString('short', 'longer_string')).toBe(false);
      expect(timingSafeEqualString('secret_token_123', 'secret_token_456')).toBe(false);
    });
  });
});
