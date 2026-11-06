'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AdminLayout } from '@/components/layout/admin-layout';
import { useAdminAuth } from '@/context/admin-auth-context';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog } from '@/components/ui/dialog';
import { CreateProjectModal } from '@/components/projects/create-project-modal';
import { EditProjectModal } from '@/components/projects/edit-project-modal';
import {
  FolderKanban,
  Plus,
  Search,
  Settings,
  Trash2,
  ExternalLink,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import { Project } from '@/lib/frontend/types';

function ProjectsContent() {
  const { fetchWithCsrf } = useAdminAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all');

  // Modals state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [deletingProject, setDeletingProject] = useState<Project | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const loadProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetchWithCsrf('/api/admin/projects');
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || 'Gagal memuat daftar project');
      }
      const data = await res.json();
      setProjects(data?.projects || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Terjadi kesalahan jaringan');
    } finally {
      setIsLoading(false);
    }
  }, [fetchWithCsrf]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const handleDelete = async () => {
    if (!deletingProject) return;
    setIsDeleting(true);
    try {
      const res = await fetchWithCsrf(`/api/admin/projects/${deletingProject.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error?.message || 'Gagal menghapus project');
      }
      setProjects((prev) => prev.filter((p) => p.id !== deletingProject.id));
      setDeletingProject(null);
      setDeleteConfirmText('');
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Gagal menghapus project');
    } finally {
      setIsDeleting(false);
    }
  };

  // Filtered projects
  const filteredProjects = projects.filter((p) => {
    const matchSearch =
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.description && p.description.toLowerCase().includes(search.toLowerCase()));
    const matchStatus = statusFilter === 'all' || p.status === statusFilter;
    return matchSearch && matchStatus;
  });

  return (
    <div className="space-y-6">
      {/* Top Bar: Title & Action */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Manajemen Project</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Kelola konfigurasi project, limit RPM/concurrency, kredensial AI, dan API key klien.
          </p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="gap-2 shrink-0">
          <Plus className="w-4 h-4" />
          <span>Buat Project Baru</span>
        </Button>
      </div>

      {/* Filters bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3 rounded-lg border border-border bg-card">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari nama project..."
            className="w-full pl-9 pr-3 py-1.5 rounded-md border border-border bg-muted text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring min-h-[44px]"
          />
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="filter-status-select" className="text-xs text-muted-foreground shrink-0">
            Status:
          </label>
          <select
            id="filter-status-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'disabled')}
            className="rounded-md border border-border bg-muted px-3 py-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring min-h-[44px]"
          >
            <option value="all">Semua Status</option>
            <option value="active">Hanya Aktif</option>
            <option value="disabled">Hanya Nonaktif</option>
          </select>
        </div>
      </div>

      {/* Content Area: 8 States Handling */}
      {isLoading ? (
        /* Loading Shimmer State */
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="p-4 space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center justify-between gap-4 py-2 border-b border-border/50">
                <div className="space-y-1.5 flex-1">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-72" />
                </div>
                <Skeleton className="h-6 w-20 rounded-[4px]" />
                <Skeleton className="h-8 w-24 rounded-md" />
              </div>
            ))}
          </div>
        </div>
      ) : error ? (
        /* Error State */
        <div role="alert" className="p-8 rounded-lg border border-red-500/30 bg-red-500/10 text-center space-y-3">
          <AlertCircle className="w-8 h-8 text-red-400 mx-auto" />
          <h3 className="text-sm font-semibold text-red-400">Gagal Memuat Data Project</h3>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">{error}</p>
          <Button variant="outline" size="sm" onClick={loadProjects} className="mt-2 gap-2">
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Coba Lagi</span>
          </Button>
        </div>
      ) : filteredProjects.length === 0 ? (
        /* Empty State */
        <div className="p-12 rounded-lg border border-border bg-card text-center space-y-4">
          <div className="w-12 h-12 rounded-md bg-muted flex items-center justify-center mx-auto text-muted-foreground">
            <FolderKanban className="w-6 h-6" />
          </div>
          <div className="space-y-1 max-w-sm mx-auto">
            <h3 className="text-base font-semibold text-foreground">
              {search || statusFilter !== 'all' ? 'Tidak Ada Project yang Cocok' : 'Belum Ada Project'}
            </h3>
            <p className="text-xs text-muted-foreground">
              {search || statusFilter !== 'all'
                ? 'Coba sesuaikan kata kunci pencarian atau filter status Anda.'
                : 'Project diperlukan untuk membuat API key klien dan mengelola batas pemakaian AI gateway.'}
            </p>
          </div>
          {search || statusFilter !== 'all' ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSearch('');
                setStatusFilter('all');
              }}
            >
              Reset Filter
            </Button>
          ) : (
            <Button onClick={() => setIsCreateOpen(true)} className="gap-2">
              <Plus className="w-4 h-4" />
              <span>Buat Project Pertama</span>
            </Button>
          )}
        </div>
      ) : (
        /* Table of Projects (Responsive: stacked on mobile, full table on tablet+) */
        <div className="rounded-lg border border-border bg-card overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/80 text-muted-foreground border-b border-border font-medium">
                <tr>
                  <th className="py-3 px-4">Nama & Deskripsi</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Batas RPM</th>
                  <th className="py-3 px-4">Batas Concurrency</th>
                  <th className="py-3 px-4">Dibuat Pada</th>
                  <th className="py-3 px-4 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredProjects.map((p) => (
                  <tr
                    key={p.id}
                    className="hover:bg-muted/40 transition-colors group focus-within:bg-muted/50"
                  >
                    <td className="py-3.5 px-4">
                      <Link
                        href={`/admin/projects/${p.id}`}
                        className="font-semibold text-foreground hover:text-primary transition-colors text-sm flex items-center gap-1.5 group-hover:underline"
                      >
                        <span>{p.name}</span>
                        <ExternalLink className="w-3.5 h-3.5 opacity-60" />
                      </Link>
                      {p.description && (
                        <p className="text-[11px] text-muted-foreground line-clamp-1 mt-0.5">
                          {p.description}
                        </p>
                      )}
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <Badge variant={p.status === 'active' ? 'active' : 'disabled'}>
                        {p.status === 'active' ? 'Aktif' : 'Nonaktif'}
                      </Badge>
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-mono text-foreground">
                      {p.rpmLimit} RPM
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap font-mono text-foreground">
                      {p.concurrencyLimit} Slot
                    </td>
                    <td className="py-3.5 px-4 whitespace-nowrap text-muted-foreground">
                      {new Date(p.createdAt).toLocaleDateString('id-ID', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <Link
                          href={`/admin/projects/${p.id}`}
                          className="px-2.5 py-1.5 rounded-md text-xs font-medium text-primary hover:bg-primary/10 transition-colors min-h-[36px] flex items-center"
                        >
                          Kelola
                        </Link>
                        <button
                          type="button"
                          onClick={() => setEditingProject(p)}
                          aria-label={`Edit ${p.name}`}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors min-h-[36px] min-w-[36px] flex items-center justify-center cursor-pointer"
                        >
                          <Settings className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeletingProject(p);
                            setDeleteConfirmText('');
                          }}
                          aria-label={`Hapus ${p.name}`}
                          className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors min-h-[36px] min-w-[36px] flex items-center justify-center cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create Project Modal */}
      <CreateProjectModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={(newProj) => {
          setProjects((prev) => [newProj, ...prev]);
        }}
        fetchWithCsrf={fetchWithCsrf}
      />

      {/* Edit Project Modal */}
      <EditProjectModal
        isOpen={Boolean(editingProject)}
        project={editingProject}
        onClose={() => setEditingProject(null)}
        onSuccess={(updated) => {
          setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
        }}
        fetchWithCsrf={fetchWithCsrf}
      />

      {/* Delete Confirmation Dialog */}
      {deletingProject && (
        <Dialog
          isOpen={Boolean(deletingProject)}
          onClose={() => {
            setDeletingProject(null);
            setDeleteConfirmText('');
          }}
          title="Konfirmasi Hapus Project"
          description={`Tindakan ini tidak dapat dibatalkan. Menghapus project akan mencabut seluruh API key dan alias terkait.`}
          maxWidth="max-w-md"
        >
          <div className="space-y-4">
            <div className="p-3 rounded-md border border-red-500/30 bg-red-500/10 text-xs text-red-400">
              Ketik nama project <strong>{deletingProject.name}</strong> di bawah ini untuk mengonfirmasi:
            </div>
            <input
              type="text"
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={deletingProject.name}
              className="w-full rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex justify-end gap-3 pt-3 border-t border-border">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setDeletingProject(null);
                  setDeleteConfirmText('');
                }}
                disabled={isDeleting}
              >
                Batal
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={deleteConfirmText !== deletingProject.name || isDeleting}
                isLoading={isDeleting}
                onClick={handleDelete}
              >
                Hapus Project Permanen
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <AdminLayout title="Konsol Administrasi Gateway">
      <ProjectsContent />
    </AdminLayout>
  );
}
