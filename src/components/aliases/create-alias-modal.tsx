import React, { useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle, Link as LinkIcon } from 'lucide-react';
import { ModelAlias, ProviderCredential } from '@/lib/frontend/types';

interface CreateAliasModalProps {
  isOpen: boolean;
  projectId: string;
  credentials: ProviderCredential[];
  onClose: () => void;
  onSuccess: (alias: ModelAlias) => void;
  fetchWithCsrf: (url: string, init?: RequestInit) => Promise<Response>;
}

export function CreateAliasModal({
  isOpen,
  projectId,
  credentials,
  onClose,
  onSuccess,
  fetchWithCsrf,
}: CreateAliasModalProps) {
  const [alias, setAlias] = useState('');
  const [upstreamModel, setUpstreamModel] = useState('gemini-2.5-flash');
  const [boundCredentialId, setBoundCredentialId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // STRICT FILTER: Only active Gemini credentials belonging to this project
  const eligibleCredentials = credentials.filter(
    (c) => c.status === 'active' && c.provider === 'gemini' && c.projectId === projectId
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!boundCredentialId) {
      setError('Kredensial Gemini aktif wajib dipilih untuk mengikat model alias.');
      return;
    }

    setIsLoading(true);

    try {
      const res = await fetchWithCsrf(`/api/admin/projects/${projectId}/aliases`, {
        method: 'POST',
        body: JSON.stringify({
          alias: alias.trim(),
          upstreamModel: upstreamModel.trim(),
          boundCredentialId,
          status: 'active',
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error?.message || 'Gagal membuat model alias');
        return;
      }

      if (data?.alias) {
        onSuccess(data.alias);
        onClose();
        setAlias('');
        setUpstreamModel('gemini-2.5-flash');
        setBoundCredentialId('');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Terjadi kesalahan sistem saat membuat alias');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Buat Model Alias Baru"
      description="Petakan nama model publik ke upstream Gemini provider resmi yang terikat pada project ini."
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
          <label htmlFor="create-alias-name" className="block text-xs font-medium text-foreground mb-1">
            Nama Alias Publik <span className="text-red-400">*</span>
          </label>
          <input
            id="create-alias-name"
            type="text"
            required
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            placeholder="Contoh: gemini-default atau gemini-fast"
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            Nama model yang akan dikirim klien pada payload `/v1/chat/completions`.
          </p>
        </div>

        <div>
          <label htmlFor="create-alias-upstream" className="block text-xs font-medium text-foreground mb-1">
            Upstream Model Gemini <span className="text-red-400">*</span>
          </label>
          <select
            id="create-alias-upstream"
            value={upstreamModel}
            onChange={(e) => setUpstreamModel(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
          >
            <option value="gemini-2.5-flash">gemini-2.5-flash (Direkomendasikan - Default)</option>
            <option value="gemini-2.5-pro">gemini-2.5-pro</option>
            <option value="gemini-1.5-flash">gemini-1.5-flash</option>
            <option value="gemini-1.5-pro">gemini-1.5-pro</option>
          </select>
        </div>

        <div>
          <label htmlFor="create-alias-cred" className="block text-xs font-medium text-foreground mb-1">
            Kredensial Gemini Terikat (Project Sama) <span className="text-red-400">*</span>
          </label>
          {eligibleCredentials.length === 0 ? (
            <div className="p-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 text-xs text-yellow-500">
              Belum ada kredensial Gemini aktif pada project ini. Daftarkan kredensial Gemini terlebih dahulu di tab Provider Credentials sebelum mengikat alias.
            </div>
          ) : (
            <select
              id="create-alias-cred"
              required
              value={boundCredentialId}
              onChange={(e) => setBoundCredentialId(e.target.value)}
              className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">-- Pilih Kredensial Gemini Aktif --</option>
              {eligibleCredentials.map((cred) => (
                <option key={cred.id} value={cred.id}>
                  {cred.displayName} (v{cred.keyVersion})
                </option>
              ))}
            </select>
          )}
          <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
            <LinkIcon className="w-3 h-3 text-primary" />
            Hanya menampilkan kredensial berstatus aktif dari project ini.
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-3 border-t border-border">
          <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
            Batal
          </Button>
          <Button
            type="submit"
            isLoading={isLoading}
            disabled={eligibleCredentials.length === 0}
          >
            Ikat Model Alias
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
