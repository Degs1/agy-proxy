import React, { useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import { Project } from '@/lib/frontend/types';

interface CreateProjectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (project: Project) => void;
  fetchWithCsrf: (url: string, init?: RequestInit) => Promise<Response>;
}

export function CreateProjectModal({
  isOpen,
  onClose,
  onSuccess,
  fetchWithCsrf,
}: CreateProjectModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rpmLimit, setRpmLimit] = useState(60);
  const [concurrencyLimit, setConcurrencyLimit] = useState(5);
  const [allowedModels, setAllowedModels] = useState('gemini-default');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const models = allowedModels
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean);

      const res = await fetchWithCsrf('/api/admin/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          rpmLimit: Number(rpmLimit),
          concurrencyLimit: Number(concurrencyLimit),
          allowedModels: models.length > 0 ? models : ['gemini-default'],
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error?.message || 'Gagal membuat project baru');
        return;
      }

      if (data?.project) {
        onSuccess(data.project);
        onClose();
        // Reset form
        setName('');
        setDescription('');
        setRpmLimit(60);
        setConcurrencyLimit(5);
        setAllowedModels('gemini-default');
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
      title="Buat Project Baru"
      description="Konfigurasikan workspace dan alokasi batas pemakaian AI gateway."
      maxWidth="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div role="alert" className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div>
          <label htmlFor="create-project-name" className="block text-xs font-medium text-foreground mb-1">
            Nama Project <span className="text-red-400">*</span>
          </label>
          <input
            id="create-project-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Contoh: Production Assistant"
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div>
          <label htmlFor="create-project-desc" className="block text-xs font-medium text-foreground mb-1">
            Deskripsi (Opsional)
          </label>
          <textarea
            id="create-project-desc"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Keterangan alur penggunaan project ini..."
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="create-project-rpm" className="block text-xs font-medium text-foreground mb-1">
              Batas RPM (Default: 60)
            </label>
            <input
              id="create-project-rpm"
              type="number"
              min={1}
              required
              value={rpmLimit}
              onChange={(e) => setRpmLimit(parseInt(e.target.value, 10) || 60)}
              className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label htmlFor="create-project-concurrency" className="block text-xs font-medium text-foreground mb-1">
              Batas Concurrency (Default: 5)
            </label>
            <input
              id="create-project-concurrency"
              type="number"
              min={1}
              required
              value={concurrencyLimit}
              onChange={(e) => setConcurrencyLimit(parseInt(e.target.value, 10) || 5)}
              className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div>
          <label htmlFor="create-project-models" className="block text-xs font-medium text-foreground mb-1">
            Model yang Diizinkan (Pisahkan dengan koma)
          </label>
          <input
            id="create-project-models"
            type="text"
            value={allowedModels}
            onChange={(e) => setAllowedModels(e.target.value)}
            placeholder="gemini-default, gemini-flash"
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <p className="text-[11px] text-muted-foreground mt-1">Default: gemini-default</p>
        </div>

        <div className="flex justify-end gap-3 pt-3 border-t border-border">
          <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
            Batal
          </Button>
          <Button type="submit" isLoading={isLoading}>
            Simpan Project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
