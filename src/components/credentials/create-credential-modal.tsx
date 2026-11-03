import React, { useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle, Lock } from 'lucide-react';
import { ProviderCredential } from '@/lib/frontend/types';

interface CreateCredentialModalProps {
  isOpen: boolean;
  projectId: string;
  onClose: () => void;
  onSuccess: (credential: ProviderCredential) => void;
  fetchWithCsrf: (url: string, init?: RequestInit) => Promise<Response>;
}

export function CreateCredentialModal({
  isOpen,
  projectId,
  onClose,
  onSuccess,
  fetchWithCsrf,
}: CreateCredentialModalProps) {
  const [displayName, setDisplayName] = useState('');
  const [provider, setProvider] = useState<'gemini'>('gemini');
  const [secret, setSecret] = useState('');
  const [maxConcurrent, setMaxConcurrent] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const payload: Record<string, unknown> = {
        displayName: displayName.trim(),
        provider: 'gemini',
        credentialType: 'api_key',
        secret: secret.trim(),
        status: 'active',
      };

      if (maxConcurrent.trim()) {
        const mc = parseInt(maxConcurrent, 10);
        if (!isNaN(mc) && mc > 0) {
          payload.maxConcurrent = mc;
        }
      }

      const res = await fetchWithCsrf(`/api/admin/projects/${projectId}/credentials`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error?.message || 'Gagal mendaftarkan kredensial provider');
        return;
      }

      if (data?.credential) {
        onSuccess(data.credential);
        onClose();
        // Reset form immediately to purge secret from memory
        setDisplayName('');
        setSecret('');
        setMaxConcurrent('');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Terjadi kesalahan sistem');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Tambah Kredensial Provider"
      description="Daftarkan API key provider AI resmi. Kunci akan dienkripsi dengan AES-256-GCM."
      maxWidth="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div role="alert" className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div>
          <label htmlFor="create-cred-provider" className="block text-xs font-medium text-foreground mb-1">
            AI Provider
          </label>
          <select
            id="create-cred-provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as 'gemini')}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="gemini">Google Gemini API resmi (Aktif MVP)</option>
            <option value="antigravity" disabled>
              Google Antigravity (Unsupported / Pending Verification)
            </option>
          </select>
          <p className="text-[11px] text-muted-foreground mt-1">
            Sesuai keputusan arsitektur MVP, hanya Gemini API resmi yang didukung secara operasional.
          </p>
        </div>

        <div>
          <label htmlFor="create-cred-name" className="block text-xs font-medium text-foreground mb-1">
            Display Name <span className="text-red-400">*</span>
          </label>
          <input
            id="create-cred-name"
            type="text"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Contoh: Gemini Pro Primary Key"
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div>
          <label htmlFor="create-cred-secret" className="block text-xs font-medium text-foreground mb-1">
            Gemini API Key Secret <span className="text-red-400">*</span>
          </label>
          <div className="relative">
            <input
              id="create-cred-secret"
              type="password"
              required
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="AIzaSy..."
              className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
            <Lock className="w-3 h-3 text-emerald-400" />
            Dienkripsi server-side dengan AES-256-GCM. Secret tidak pernah ditampilkan kembali.
          </p>
        </div>

        <div>
          <label htmlFor="create-cred-concurrency" className="block text-xs font-medium text-foreground mb-1">
            Max Concurrent Requests (Opsional)
          </label>
          <input
            id="create-cred-concurrency"
            type="number"
            min={1}
            value={maxConcurrent}
            onChange={(e) => setMaxConcurrent(e.target.value)}
            placeholder="Tidak terbatas (default)"
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="flex justify-end gap-3 pt-3 border-t border-border">
          <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
            Batal
          </Button>
          <Button type="submit" isLoading={isLoading}>
            Enkripsi & Simpan Kredensial
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
