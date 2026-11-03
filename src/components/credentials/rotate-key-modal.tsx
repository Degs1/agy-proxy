import React, { useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle, RefreshCw, ShieldAlert } from 'lucide-react';
import { ProviderCredential } from '@/lib/frontend/types';

interface RotateKeyModalProps {
  isOpen: boolean;
  projectId: string;
  credential: ProviderCredential | null;
  onClose: () => void;
  onSuccess: (updated: ProviderCredential) => void;
  fetchWithCsrf: (url: string, init?: RequestInit) => Promise<Response>;
}

export function RotateKeyModal({
  isOpen,
  projectId,
  credential,
  onClose,
  onSuccess,
  fetchWithCsrf,
}: RotateKeyModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!credential) return null;

  const handleRotate = async () => {
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetchWithCsrf(
        `/api/admin/projects/${projectId}/credentials/${credential.id}/rotate`,
        {
          method: 'POST',
        }
      );

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error?.message || 'Gagal merotasi versi kunci enkripsi kredensial');
        return;
      }

      if (data?.credential) {
        onSuccess(data.credential);
        onClose();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Terjadi kesalahan sistem saat rotasi');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Rotasi Kunci Enkripsi Kredensial"
      description={`Rotasi versi enkripsi untuk ${credential.displayName}`}
      maxWidth="max-w-md"
    >
      <div className="space-y-4">
        {error && (
          <div role="alert" className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="p-3.5 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-xs text-yellow-400 flex items-start gap-2.5">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-yellow-500" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">Konfirmasi Re-Enkripsi AES-256-GCM:</p>
            <p className="text-muted-foreground leading-relaxed">
              Sistem akan mendekripsi kredensial ini menggunakan kunci versi saat ini (Versi{' '}
              {credential.keyVersion}), memvalidasi integritas ciphertext, dan mengenkripsinya kembali
              menggunakan versi kunci lingkungan yang aktif.
            </p>
          </div>
        </div>

        <div className="text-xs text-muted-foreground bg-muted p-3 rounded-lg font-mono">
          <div>Kredensial: {credential.displayName}</div>
          <div>Provider: {credential.provider}</div>
          <div>Versi Kunci Saat Ini: v{credential.keyVersion}</div>
        </div>

        <div className="flex justify-end gap-3 pt-3 border-t border-border">
          <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
            Batal
          </Button>
          <Button type="button" onClick={handleRotate} isLoading={isLoading}>
            <RefreshCw className="w-4 h-4" />
            <span>Jalankan Rotasi Kunci</span>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
