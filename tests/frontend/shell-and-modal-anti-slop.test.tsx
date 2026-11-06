// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Sidebar } from '@/components/layout/sidebar';
import { Dialog } from '@/components/ui/dialog';
import { SecretDisplayModal } from '@/components/modals/secret-display-modal';

// Mock next/navigation
let currentMockPathname = '/admin/projects';
vi.mock('next/navigation', () => ({
  usePathname: () => currentMockPathname,
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

// Mock admin-auth-context
vi.mock('@/context/admin-auth-context', () => ({
  useAdminAuth: () => ({
    logout: vi.fn(),
    admin: { email: 'admin@internal.net', role: 'superadmin' },
    isLoading: false,
  }),
}));

describe('TASK-094: Shell Layout, Sidebar, Modal, and Navigation Accessibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    currentMockPathname = '/admin/projects';
  });

  describe('Sidebar Navigation Semantics & Anti-Slop Styling (F-02, F-07, F-09)', () => {
    it('provides aria-current="page" on the active navigation link and omits it on inactive links', () => {
      currentMockPathname = '/admin/projects';
      const { rerender } = render(<Sidebar />);

      // Semantic <nav> landmark
      const navLandmark = screen.getByRole('navigation', { name: /Navigasi Utama/i });
      expect(navLandmark).toBeInTheDocument();

      // Active link
      const projectsLink = screen.getByRole('link', { name: /Projects/i });
      expect(projectsLink).toHaveAttribute('aria-current', 'page');
      expect(projectsLink.className).toContain('text-primary');

      // Inactive links
      const overviewLink = screen.getByRole('link', { name: /Overview/i });
      const monitoringLink = screen.getByRole('link', { name: /Monitoring/i });
      expect(overviewLink).not.toHaveAttribute('aria-current');
      expect(monitoringLink).not.toHaveAttribute('aria-current');

      // Switch active route to /admin/monitoring
      currentMockPathname = '/admin/monitoring';
      rerender(<Sidebar />);

      expect(projectsLink).not.toHaveAttribute('aria-current');
      expect(screen.getByRole('link', { name: /Monitoring/i })).toHaveAttribute('aria-current', 'page');
    });

    it('eliminates AI-slop glow shadow-primary/20 on the brand logo shield', () => {
      const { container } = render(<Sidebar />);
      const brandLogoContainer = container.querySelector('a[href="/admin/projects"] div');
      expect(brandLogoContainer).not.toBeNull();

      // Verify no shadow-primary/20 glow
      expect(brandLogoContainer?.className).not.toContain('shadow-primary');
      expect(brandLogoContainer?.className).not.toContain('shadow-md');
      // Verify crisp technical border
      expect(brandLogoContainer?.className).toContain('border');
      expect(brandLogoContainer?.className).toContain('border-border/80');
    });

    it('renders mobile backdrop with high-density solid bg-slate-950/80 and no backdrop-blur-sm', () => {
      const handleCloseMobile = vi.fn();
      render(<Sidebar isOpenOnMobile={true} onCloseMobile={handleCloseMobile} />);

      const backdrop = screen.getByTestId('sidebar-mobile-backdrop');
      expect(backdrop).toBeInTheDocument();

      // High density solid backdrop
      expect(backdrop.className).toContain('bg-slate-950/80');
      // No glassmorphism blur
      expect(backdrop.className).not.toContain('backdrop-blur');

      // Clicking backdrop calls onCloseMobile
      fireEvent.click(backdrop);
      expect(handleCloseMobile).toHaveBeenCalledTimes(1);
    });
  });

  describe('Dialog Component Anti-Slop (F-07, F-08)', () => {
    it('uses solid technical backdrop without blur and replaces shadow-2xl with subtle shadow', () => {
      const handleClose = vi.fn();
      render(
        <Dialog isOpen={true} onClose={handleClose} title="Konfigurasi Model">
          <p>Dialog Content</p>
        </Dialog>
      );

      const dialogOverlay = screen.getByRole('dialog');
      expect(dialogOverlay).toBeInTheDocument();

      // Solid technical backdrop
      expect(dialogOverlay.className).toContain('bg-slate-950/80');
      expect(dialogOverlay.className).not.toContain('backdrop-blur');

      // Dialog container element inside
      const dialogCard = dialogOverlay.firstElementChild as HTMLElement;
      expect(dialogCard).not.toBeNull();
      expect(dialogCard.className).not.toContain('shadow-2xl');
      expect(dialogCard.className).toContain('border-border/80');
      expect(dialogCard.className).toContain('shadow-md');
    });

    it('closes on backdrop click and Escape key when preventDismiss is false', () => {
      const handleClose = vi.fn();
      render(
        <Dialog isOpen={true} onClose={handleClose} title="Test Dismiss">
          <p>Dismissable Content</p>
        </Dialog>
      );

      const dialogOverlay = screen.getByRole('dialog');
      fireEvent.click(dialogOverlay);
      expect(handleClose).toHaveBeenCalledTimes(1);

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(handleClose).toHaveBeenCalledTimes(2);
    });
  });

  describe('SecretDisplayModal Anti-Slop & Zero-Plaintext-Recall (F-07, F-08)', () => {
    it('uses solid technical backdrop and subtle elevation while strictly preserving Zero-Plaintext-Recall locks', () => {
      const handleClose = vi.fn();
      render(
        <SecretDisplayModal
          isOpen={true}
          secret="agw_secret_antislop_verified_123"
          onClose={handleClose}
        />
      );

      const modalOverlay = screen.getByRole('dialog');
      expect(modalOverlay).toBeInTheDocument();

      // High-density technical solid backdrop, no blur
      expect(modalOverlay.className).toContain('bg-slate-950/80');
      expect(modalOverlay.className).not.toContain('backdrop-blur');

      // Container card subtle elevation and contrast border
      const modalBox = modalOverlay.firstElementChild as HTMLElement;
      expect(modalBox).not.toBeNull();
      expect(modalBox.className).not.toContain('shadow-2xl');
      expect(modalBox.className).toContain('border-border/80');
      expect(modalBox.className).toContain('shadow-md');

      // Zero-Plaintext-Recall guarantee: backdrop click and Escape are LOCKED
      fireEvent.click(modalOverlay);
      expect(handleClose).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(handleClose).not.toHaveBeenCalled();

      // Close button disabled until confirmed
      const closeBtn = screen.getByRole('button', { name: /Selesai & Tutup/i }) as HTMLButtonElement;
      expect(closeBtn.disabled).toBe(true);

      // Confirm checkbox and close
      const checkbox = screen.getByLabelText(/Saya telah menyalin dan menyimpan API key ini/i);
      fireEvent.click(checkbox);
      expect(closeBtn.disabled).toBe(false);

      fireEvent.click(closeBtn);
      expect(handleClose).toHaveBeenCalledTimes(1);
    });
  });
});
