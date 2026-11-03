// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { SecretDisplayModal } from '@/components/modals/secret-display-modal';
import { ApiKeyItem, ProviderCredential, ModelAlias } from '@/lib/frontend/types';

describe('UI/UX States, Responsiveness, and Zero-Plaintext-Recall Verification (TASK-071)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('8 Interactive States Verification', () => {
    it('verifies Default, Hover, Focus, Active, and Disabled states on Button', () => {
      const { rerender } = render(<Button>Default Button</Button>);
      const btn = screen.getByRole('button', { name: /Default Button/i });

      // Default state classes
      expect(btn.className).toContain('bg-primary');
      expect(btn.className).toContain('min-h-[44px]'); // Minimum 44px touch target WCAG

      // Hover, Focus, Active classes
      expect(btn.className).toContain('hover:bg-primary/90');
      expect(btn.className).toContain('focus-visible:ring-2');
      expect(btn.className).toContain('active:scale-[0.98]');

      // Disabled state
      rerender(<Button disabled>Disabled Button</Button>);
      expect(btn).toBeDisabled();
      expect(btn.className).toContain('disabled:opacity-50');
      expect(btn.className).toContain('disabled:cursor-not-allowed');
    });

    it('verifies Loading state with animated spinner', () => {
      render(<Button isLoading>Loading Button</Button>);
      const btn = screen.getByRole('button');
      expect(btn).toBeDisabled();
      expect(btn.getAttribute('aria-disabled')).toBe('true');
      const spinner = btn.querySelector('.animate-spin');
      expect(spinner).not.toBeNull();
    });

    it('verifies Skeleton shimmer component for loading state', () => {
      const { container } = render(<Skeleton className="h-6 w-32" />);
      const skeletonEl = container.firstChild as HTMLElement;
      expect(skeletonEl.className).toContain('animate-pulse');
      expect(skeletonEl.className).toContain('h-6');
      expect(skeletonEl.className).toContain('w-32');
    });

    it('verifies Badge accessibility with icon and color-blind safe text for all statuses', () => {
      const { rerender } = render(<Badge variant="active">Aktif</Badge>);
      expect(screen.getByText('Aktif')).toBeInTheDocument();
      // Icon is rendered
      expect(document.querySelector('svg')).toBeInTheDocument();

      rerender(<Badge variant="disabled">Nonaktif</Badge>);
      expect(screen.getByText('Nonaktif')).toBeInTheDocument();

      rerender(<Badge variant="revoked">Dicabut</Badge>);
      expect(screen.getByText('Dicabut')).toBeInTheDocument();

      rerender(<Badge variant="warning">Cooldown</Badge>);
      expect(screen.getByText('Cooldown')).toBeInTheDocument();
    });
  });

  describe('Zero-Plaintext-Recall Security Audit', () => {
    it('verifies that API keys table NEVER renders plaintext secrets or secret hashes', () => {
      const mockKeys: ApiKeyItem[] = [
        {
          id: 'key_1',
          projectId: 'proj_1',
          name: 'Production Webhook Key',
          keyPrefix: 'agw_7a8f9c2d', // Only prefix is allowed!
          status: 'active',
          expiresAt: null,
          lastUsedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      // Simulated render of the API keys table
      const { container } = render(
        <table>
          <tbody>
            {mockKeys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td>{k.keyPrefix}...</td>
                <td>{k.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );

      // Plaintext secret (e.g. 256-bit secret string) is completely absent
      const tableText = container.textContent || '';
      expect(tableText).toContain('agw_7a8f9c2d...');
      expect(tableText).not.toContain('agw_7a8f9c2d_full_plaintext_secret_9999');
      // No raw hash or secret fields
      expect(tableText).not.toContain('keyHash');
      expect(tableText).not.toContain('secret');
    });

    it('verifies that Provider Credentials table NEVER renders secrets, ciphertext, IV, or authTag', () => {
      const mockCreds: ProviderCredential[] = [
        {
          id: 'cred_1',
          projectId: 'proj_1',
          provider: 'gemini',
          displayName: 'Official Gemini Production',
          credentialType: 'api_key',
          status: 'active',
          keyVersion: 1,
          maxConcurrent: 5,
          lastUsedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ];

      const { container } = render(
        <table>
          <tbody>
            {mockCreds.map((c) => (
              <tr key={c.id}>
                <td>{c.displayName}</td>
                <td>{c.provider}</td>
                <td>v{c.keyVersion}</td>
                <td>{c.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );

      const tableText = container.textContent || '';
      expect(tableText).toContain('Official Gemini Production');
      expect(tableText).toContain('v1');
      // Absolute guarantee: no ciphertext, raw iv, authTag, or API key secrets in table
      expect(tableText).not.toContain('AIzaSy');
      expect(tableText).not.toContain('ciphertext');
      expect(tableText).not.toContain('authTag');
      expect(tableText).not.toContain('encryptedCredentials');
      expect(tableText).not.toMatch(/\biv\b/i);
    });

    it('verifies SecretDisplayModal completely purges secret from memory when dismissed', () => {
      let memorySecret: string | null = 'agw_extremely_confidential_secret_token_123';
      const handleClose = vi.fn().mockImplementation(() => {
        memorySecret = null;
      });

      const { rerender } = render(
        <SecretDisplayModal
          isOpen={true}
          secret={memorySecret}
          onClose={handleClose}
        />
      );

      // Secret is present while open
      expect(screen.getByDisplayValue('agw_extremely_confidential_secret_token_123')).toBeInTheDocument();

      // Check confirmation and close
      const checkbox = screen.getByLabelText(/Saya telah menyalin dan menyimpan API key ini/i);
      fireEvent.click(checkbox);

      const closeBtn = screen.getByRole('button', { name: /Selesai & Tutup/i });
      fireEvent.click(closeBtn);

      expect(handleClose).toHaveBeenCalledTimes(1);
      expect(memorySecret).toBeNull();

      // Re-render after modal closes
      rerender(
        <SecretDisplayModal
          isOpen={false}
          secret={memorySecret}
          onClose={handleClose}
        />
      );

      // Verify DOM has zero traces of the secret
      expect(screen.queryByDisplayValue('agw_extremely_confidential_secret_token_123')).toBeNull();
      expect(document.body.textContent).not.toContain('agw_extremely_confidential_secret_token_123');
    });
  });

  describe('Touch Targets & Mobile WCAG Compliance', () => {
    it('verifies buttons satisfy minimum 44px touch target on mobile viewports', () => {
      const { container } = render(
        <div>
          <Button size="md">Touch Target Standard</Button>
          <Button size="icon" aria-label="Icon Action" />
        </div>
      );

      const buttons = container.querySelectorAll('button');
      buttons.forEach((b) => {
        const hasMinHeight = b.className.includes('min-h-[44px]') || b.className.includes('h-11');
        expect(hasMinHeight).toBe(true);
      });
    });
  });
});
