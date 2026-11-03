// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { SecretDisplayModal } from '@/components/modals/secret-display-modal';

describe('Modal Sakral — One-Time Secret Display (TASK-069 & Zero-Plaintext-Recall)', () => {
  const mockClipboard = {
    writeText: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    Object.assign(navigator, {
      clipboard: mockClipboard,
    });
  });

  it('renders plaintext secret when opened and allows copying with visual feedback', async () => {
    const handleClose = vi.fn();
    const secret = 'agw_live_secret_entropy_256bits_xyz987';

    render(
      <SecretDisplayModal
        isOpen={true}
        title="Simpan API Key Anda Sekarang"
        secret={secret}
        onClose={handleClose}
      />
    );

    // Secret is rendered
    const input = screen.getByLabelText(/Kunci Rahasia/i) as HTMLInputElement;
    expect(input.value).toBe(secret);

    // Warning banner is visible
    expect(screen.getByRole('alert')).toHaveTextContent(/HANYA DITAMPILKAN SATU KALI/i);

    // Copy button
    const copyBtn = screen.getByRole('button', { name: /Salin Kunci/i });
    expect(copyBtn).toBeTruthy();

    await act(async () => {
      fireEvent.click(copyBtn);
    });

    expect(mockClipboard.writeText).toHaveBeenCalledWith(secret);
    expect(screen.getByText(/Tersalin!/i)).toBeTruthy();
  });

  it('keeps close button disabled until mandatory confirmation checkbox is checked', () => {
    const handleClose = vi.fn();
    const secret = 'agw_secret_test_123';

    render(
      <SecretDisplayModal
        isOpen={true}
        secret={secret}
        onClose={handleClose}
      />
    );

    const closeBtn = screen.getByRole('button', { name: /Selesai & Tutup/i }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);

    // Clicking disabled button should not call onClose
    fireEvent.click(closeBtn);
    expect(handleClose).not.toHaveBeenCalled();

    // Check the confirmation checkbox
    const checkbox = screen.getByLabelText(/Saya telah menyalin dan menyimpan API key ini/i);
    fireEvent.click(checkbox);

    // Button should now be enabled
    expect(closeBtn.disabled).toBe(false);

    // Clicking enabled button calls onClose
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('locks backdrop click and Escape key from closing the modal accidentally', () => {
    const handleClose = vi.fn();
    const secret = 'agw_secret_test_lock';

    render(
      <SecretDisplayModal
        isOpen={true}
        secret={secret}
        onClose={handleClose}
      />
    );

    const dialog = screen.getByRole('dialog');

    // Simulate clicking the backdrop
    fireEvent.click(dialog);
    expect(handleClose).not.toHaveBeenCalled();

    // Simulate pressing Escape key
    fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    expect(handleClose).not.toHaveBeenCalled();
  });

  it('clears internal plaintext secret memory immediately when modal is closed', () => {
    const handleClose = vi.fn();
    const secret = 'agw_secret_purge_test';

    const { rerender } = render(
      <SecretDisplayModal
        isOpen={true}
        secret={secret}
        onClose={handleClose}
      />
    );

    const checkbox = screen.getByLabelText(/Saya telah menyalin dan menyimpan API key ini/i);
    fireEvent.click(checkbox);

    const closeBtn = screen.getByRole('button', { name: /Selesai & Tutup/i });
    fireEvent.click(closeBtn);

    expect(handleClose).toHaveBeenCalledTimes(1);

    // When parent updates isOpen to false and clears secret to null
    rerender(
      <SecretDisplayModal
        isOpen={false}
        secret={null}
        onClose={handleClose}
      />
    );

    // Nothing rendered, zero plaintext in DOM
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(secret)).toBeNull();
  });
});
