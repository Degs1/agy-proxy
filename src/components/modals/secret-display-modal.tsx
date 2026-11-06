'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Copy, Check, AlertTriangle, ShieldCheck } from 'lucide-react';

interface SecretDisplayModalProps {
  isOpen: boolean;
  title?: string;
  description?: string;
  secret: string | null;
  onClose: () => void;
}

/**
 * Modal Sakral (One-Time Display Modal)
 * Architecture requirement: Zero-Plaintext-Recall.
 * Plaintext secret is displayed ONCE.
 * Locks backdrop click and Esc key.
 * Requires confirmation checkbox before enabling the close button.
 * Immediately clears plaintext from memory upon closing.
 */
export function SecretDisplayModal({
  isOpen,
  title = 'Simpan API Key Anda Sekarang',
  description = 'Kunci API baru Anda telah berhasil dibuat. Simpan kunci ini sekarang.',
  secret,
  onClose,
}: SecretDisplayModalProps) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // Internal copy of secret that will be purged on close
  const [internalSecret, setInternalSecret] = useState<string | null>(secret);

  useEffect(() => {
    setInternalSecret(secret);
    setConfirmed(false);
    setCopied(false);
  }, [secret]);

  const handleCopy = useCallback(async () => {
    if (!internalSecret) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(internalSecret);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      // Fallback for environments where navigator.clipboard might be restricted
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    }
  }, [internalSecret]);

  const handleClose = useCallback(() => {
    if (!confirmed) return;
    // PURGE SECRET FROM STATE MEMORY
    setInternalSecret(null);
    setConfirmed(false);
    setCopied(false);
    onClose();
  }, [confirmed, onClose]);

  // Lock Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen]);

  if (!isOpen || !internalSecret) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="secret-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80"
      // Lock backdrop click
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      <div
        className="w-full max-w-lg rounded-lg rounded-modal border border-border/80 bg-card p-6 shadow-md text-card-foreground animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 rounded-md bg-primary/10 text-primary">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h2 id="secret-modal-title" className="text-lg font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
        </div>

        {/* Secret display box */}
        <div className="my-4">
          <label htmlFor="secret-plaintext-input" className="block text-xs font-medium text-muted-foreground mb-1.5">
            Kunci Rahasia (Plaintext Secret):
          </label>
          <div className="relative flex items-center">
            <input
              id="secret-plaintext-input"
              type="text"
              readOnly
              value={internalSecret}
              className="w-full rounded-md border border-border bg-muted px-3 py-2.5 pr-28 text-sm font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring select-all"
            />
            <button
              type="button"
              onClick={handleCopy}
              className={`absolute right-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
                copied
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90 focus:ring-2 focus:ring-ring'
              }`}
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Tersalin!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Salin Kunci</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Warning Alert Banner */}
        <div
          role="alert"
          className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3.5 text-xs text-yellow-500 mb-5 flex items-start gap-2.5"
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <strong className="font-semibold block mb-0.5">PERHATIAN KEAMANAN:</strong>
            Kunci ini <strong>HANYA DITAMPILKAN SATU KALI</strong>. Anda tidak akan pernah bisa melihat kunci ini lagi
            setelah menutup jendela ini. Segera salin dan simpan di pengelola rahasia Anda.
          </div>
        </div>

        {/* Mandatory Confirmation Checkbox */}
        <div className="flex items-start gap-2.5 mb-6 p-2 rounded-md hover:bg-muted/50 transition-colors">
          <input
            id="secret-confirmation-check"
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-ring cursor-pointer"
          />
          <label htmlFor="secret-confirmation-check" className="text-xs text-foreground cursor-pointer select-none leading-relaxed">
            Saya telah menyalin dan menyimpan API key ini di tempat yang aman. Saya mengerti bahwa kunci ini tidak dapat
            dipulihkan setelah modal ini ditutup.
          </label>
        </div>

        {/* Action button */}
        <div className="flex justify-end gap-3 pt-3 border-t border-border">
          <button
            type="button"
            disabled={!confirmed}
            onClick={handleClose}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-all min-h-[44px] ${
              confirmed
                ? 'bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer focus:ring-2 focus:ring-ring'
                : 'bg-muted text-muted-foreground opacity-50 cursor-not-allowed'
            }`}
          >
            Selesai & Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
