import React, { useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import { ApiKeyItem } from '@/lib/frontend/types';
import { SecretDisplayModal } from '@/components/modals/secret-display-modal';

interface CreateApiKeyModalProps {
  isOpen: boolean;
  projectId: string;
  onClose: () => void;
  onSuccess: (apiKey: ApiKeyItem) => void;
  fetchWithCsrf: (url: string, init?: RequestInit) => Promise<Response>;
}

export function CreateApiKeyModal({
  isOpen,
  projectId,
  onClose,
  onSuccess,
  fetchWithCsrf,
}: CreateApiKeyModalProps) {
  const [name, setName] = useState('');
  const [expiryDays, setExpiryDays] = useState<string>('never');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sacred Modal State (Zero-Plaintext-Recall)
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [showSecretModal, setShowSecretModal] = useState(false);
  const [newKeyItem, setNewKeyItem] = useState<ApiKeyItem | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      let expiresAt: string | undefined = undefined;
      if (expiryDays !== 'never') {
        const d = new Date();
        d.setDate(d.getDate() + parseInt(expiryDays, 10));
        expiresAt = d.toISOString();
      }

      const res = await fetchWithCsrf(`/api/admin/projects/${projectId}/keys`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          ...(expiresAt ? { expiresAt } : {}),
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error?.message || 'Gagal membuat API key');
        return;
      }

      if (data?.apiKey && data?.secret) {
        setNewKeyItem(data.apiKey);
        setCreatedSecret(data.secret);
        setShowSecretModal(true);
        // Reset creation form
        setName('');
        setExpiryDays('never');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Terjadi kesalahan sistem');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSecretModalClose = () => {
    // PURGE SECRET FROM STATE
    setCreatedSecret(null);
    setShowSecretModal(false);
    if (newKeyItem) {
      onSuccess(newKeyItem);
      setNewKeyItem(null);
    }
    onClose();
  };

  return (
    <>
      <Dialog
        isOpen={isOpen && !showSecretModal}
        onClose={onClose}
        title="Buat API Key Baru"
        description="Generate API key klien dengan entropi kriptografis minimum 256-bit."
        maxWidth="max-w-md"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div role="alert" className="p-3 rounded-md border border-red-500/40 bg-red-500/10 text-red-400 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label htmlFor="create-key-name" className="block text-xs font-medium text-foreground mb-1">
              Nama API Key <span className="text-red-400">*</span>
            </label>
            <input
              id="create-key-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contoh: Web Backend Production"
              className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label htmlFor="create-key-expiry" className="block text-xs font-medium text-foreground mb-1">
              Masa Berlaku (Expiry)
            </label>
            <select
              id="create-key-expiry"
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)}
              className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="never">Tidak Kedaluwarsa</option>
              <option value="30">30 Hari</option>
              <option value="90">90 Hari</option>
              <option value="365">1 Tahun</option>
            </select>
          </div>

          <div className="flex justify-end gap-3 pt-3 border-t border-border">
            <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
              Batal
            </Button>
            <Button type="submit" isLoading={isLoading}>
              Generate Key
            </Button>
          </div>
        </form>
      </Dialog>

      {/* MODAL SAKRAL: One-time display with zero recall */}
      <SecretDisplayModal
        isOpen={showSecretModal}
        title="Simpan API Key Anda Sekarang"
        description="Kunci API baru Anda telah berhasil digenerate dengan 256-bit CSPRNG."
        secret={createdSecret}
        onClose={handleSecretModalClose}
      />
    </>
  );
}
