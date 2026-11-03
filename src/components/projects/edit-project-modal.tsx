import React, { useState, useEffect } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import { Project } from '@/lib/frontend/types';

interface EditProjectModalProps {
  isOpen: boolean;
  project: Project | null;
  onClose: () => void;
  onSuccess: (updated: Project) => void;
  fetchWithCsrf: (url: string, init?: RequestInit) => Promise<Response>;
}

export function EditProjectModal({
  isOpen,
  project,
  onClose,
  onSuccess,
  fetchWithCsrf,
}: EditProjectModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rpmLimit, setRpmLimit] = useState(60);
  const [concurrencyLimit, setConcurrencyLimit] = useState(5);
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDescription(project.description || '');
      setRpmLimit(project.rpmLimit);
      setConcurrencyLimit(project.concurrencyLimit);
      setStatus(project.status);
      setError(null);
    }
  }, [project]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!project) return;
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetchWithCsrf(`/api/admin/projects/${project.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          rpmLimit: Number(rpmLimit),
          concurrencyLimit: Number(concurrencyLimit),
          status,
        }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error?.message || 'Gagal memperbarui konfigurasi project');
        return;
      }

      if (data?.project) {
        onSuccess(data.project);
        onClose();
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Terjadi kesalahan sistem');
    } finally {
      setIsLoading(false);
    }
  };

  if (!project) return null;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Edit Konfigurasi Project"
      description={`Ubah batas dan status operasional untuk ${project.name}`}
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
          <label htmlFor="edit-project-name" className="block text-xs font-medium text-foreground mb-1">
            Nama Project
          </label>
          <input
            id="edit-project-name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <div>
          <label htmlFor="edit-project-status" className="block text-xs font-medium text-foreground mb-1">
            Status Operasional
          </label>
          <select
            id="edit-project-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="active">Aktif (Menerima Request Gateway)</option>
            <option value="disabled">Nonaktif (Menolak Request dengan 403 Forbidden)</option>
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="edit-project-rpm" className="block text-xs font-medium text-foreground mb-1">
              Batas RPM
            </label>
            <input
              id="edit-project-rpm"
              type="number"
              min={1}
              required
              value={rpmLimit}
              onChange={(e) => setRpmLimit(parseInt(e.target.value, 10) || 1)}
              className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label htmlFor="edit-project-concurrency" className="block text-xs font-medium text-foreground mb-1">
              Batas Concurrency
            </label>
            <input
              id="edit-project-concurrency"
              type="number"
              min={1}
              required
              value={concurrencyLimit}
              onChange={(e) => setConcurrencyLimit(parseInt(e.target.value, 10) || 1)}
              className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 pt-3 border-t border-border">
          <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
            Batal
          </Button>
          <Button type="submit" isLoading={isLoading}>
            Simpan Perubahan
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
