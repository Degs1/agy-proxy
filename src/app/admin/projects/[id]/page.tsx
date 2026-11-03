'use client';

import React, { useState, useEffect, useCallback, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AdminLayout } from '@/components/layout/admin-layout';
import { useAdminAuth } from '@/context/admin-auth-context';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog } from '@/components/ui/dialog';
import { CreateApiKeyModal } from '@/components/api-keys/create-api-key-modal';
import { CreateCredentialModal } from '@/components/credentials/create-credential-modal';
import { RotateKeyModal } from '@/components/credentials/rotate-key-modal';
import { CreateAliasModal } from '@/components/aliases/create-alias-modal';
import {
  ChevronLeft,
  KeyRound,
  Layers,
  Cpu,
  Sliders,
  Plus,
  Trash2,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Shield,
  Lock,
} from 'lucide-react';
import {
  Project,
  ApiKeyItem,
  ProviderCredential,
  ModelAlias,
} from '@/lib/frontend/types';

interface ProjectDetailPageProps {
  params: Promise<{ id: string }>;
}

function ProjectDetailContent({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { fetchWithCsrf } = useAdminAuth();

  const [activeTab, setActiveTab] = useState<'config' | 'keys' | 'aliases' | 'credentials'>('config');

  // Resource states
  const [project, setProject] = useState<Project | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyItem[]>([]);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [aliases, setAliases] = useState<ModelAlias[]>([]);

  // Loading & error states
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Configuration Form State
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rpmLimit, setRpmLimit] = useState(60);
  const [concurrencyLimit, setConcurrencyLimit] = useState(5);
  const [status, setStatus] = useState<'active' | 'disabled'>('active');
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [configSuccessMsg, setConfigSuccessMsg] = useState<string | null>(null);

  // Modals state
  const [isCreateKeyOpen, setIsCreateKeyOpen] = useState(false);
  const [isCreateCredOpen, setIsCreateCredOpen] = useState(false);
  const [isCreateAliasOpen, setIsCreateAliasOpen] = useState(false);
  const [rotatingCred, setRotatingCred] = useState<ProviderCredential | null>(null);
  const [revokingKey, setRevokingKey] = useState<ApiKeyItem | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  // Load project and all resources
  const loadAll = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [projRes, keysRes, credsRes, aliasRes] = await Promise.all([
        fetchWithCsrf(`/api/admin/projects/${projectId}`),
        fetchWithCsrf(`/api/admin/projects/${projectId}/keys`),
        fetchWithCsrf(`/api/admin/projects/${projectId}/credentials`),
        fetchWithCsrf(`/api/admin/projects/${projectId}/aliases`),
      ]);

      if (!projRes.ok) {
        throw new Error('Project tidak ditemukan atau ID tidak valid');
      }

      const projData = await projRes.json();
      const p = projData.project as Project;
      setProject(p);
      setName(p.name);
      setDescription(p.description || '');
      setRpmLimit(p.rpmLimit);
      setConcurrencyLimit(p.concurrencyLimit);
      setStatus(p.status);

      if (keysRes.ok) {
        const kd = await keysRes.json();
        setApiKeys(kd.keys || []);
      }
      if (credsRes.ok) {
        const cd = await credsRes.json();
        setCredentials(cd.credentials || []);
      }
      if (aliasRes.ok) {
        const ad = await aliasRes.json();
        setAliases(ad.aliases || []);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal memuat data project');
    } finally {
      setIsLoading(false);
    }
  }, [projectId, fetchWithCsrf]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // Handle configuration update
  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSavingConfig(true);
    setConfigSuccessMsg(null);
    setError(null);

    try {
      const res = await fetchWithCsrf(`/api/admin/projects/${projectId}`, {
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
        throw new Error(data?.error?.message || 'Gagal menyimpan perubahan');
      }

      setProject(data.project);
      setConfigSuccessMsg('Konfigurasi project berhasil diperbarui.');
      setTimeout(() => setConfigSuccessMsg(null), 4000);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal menyimpan');
    } finally {
      setIsSavingConfig(false);
    }
  };

  // Handle key revocation
  const handleRevokeKey = async () => {
    if (!revokingKey) return;
    setIsRevoking(true);
    try {
      const res = await fetchWithCsrf(`/api/admin/keys/${revokingKey.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        throw new Error(d?.error?.message || 'Gagal mencabut API key');
      }
      setApiKeys((prev) =>
        prev.map((k) => (k.id === revokingKey.id ? { ...k, status: 'revoked' } : k))
      );
      setRevokingKey(null);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Gagal mencabut key');
    } finally {
      setIsRevoking(false);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="p-6 rounded-xl border border-border bg-card space-y-4">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (error && !project) {
    return (
      <div className="p-8 rounded-xl border border-red-500/30 bg-red-500/10 text-center space-y-3">
        <AlertTriangle className="w-8 h-8 text-red-400 mx-auto" />
        <h2 className="text-sm font-semibold text-red-400">Error Memuat Project</h2>
        <p className="text-xs text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/admin/projects')}>
          Kembali ke Daftar Project
        </Button>
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="space-y-6">
      {/* Top Header & Breadcrumb */}
      <div>
        <Link
          href="/admin/projects"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-2 transition-colors min-h-[36px]"
        >
          <ChevronLeft className="w-4 h-4" />
          <span>Kembali ke Daftar Project</span>
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-foreground">{project.name}</h1>
              <Badge variant={project.status === 'active' ? 'active' : 'disabled'}>
                {project.status === 'active' ? 'Aktif' : 'Nonaktif'}
              </Badge>
            </div>
            {project.description && (
              <p className="text-xs text-muted-foreground mt-1">{project.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="neutral" showIcon={false} className="font-mono text-[11px]">
              ID: {project.id}
            </Badge>
          </div>
        </div>
      </div>

      {/* Tabs Bar */}
      <div className="border-b border-border flex items-center gap-1 overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('config')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap min-h-[44px] cursor-pointer ${
            activeTab === 'config'
              ? 'border-primary text-primary font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Sliders className="w-4 h-4" />
          <span>Konfigurasi & Batas</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('keys')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap min-h-[44px] cursor-pointer ${
            activeTab === 'keys'
              ? 'border-primary text-primary font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <KeyRound className="w-4 h-4" />
          <span>API Keys ({apiKeys.length})</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('aliases')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap min-h-[44px] cursor-pointer ${
            activeTab === 'aliases'
              ? 'border-primary text-primary font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Layers className="w-4 h-4" />
          <span>Model Aliases ({aliases.length})</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('credentials')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap min-h-[44px] cursor-pointer ${
            activeTab === 'credentials'
              ? 'border-primary text-primary font-semibold'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          <Cpu className="w-4 h-4" />
          <span>Provider Credentials ({credentials.length})</span>
        </button>
      </div>

      {/* Tab 1: Konfigurasi & Batas */}
      {activeTab === 'config' && (
        <div className="max-w-2xl rounded-xl border border-border bg-card p-6 shadow-sm">
          <form onSubmit={handleSaveConfig} className="space-y-4">
            {configSuccessMsg && (
              <div role="status" className="p-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>{configSuccessMsg}</span>
              </div>
            )}
            {error && (
              <div role="alert" className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label htmlFor="detail-proj-name" className="block text-xs font-medium text-foreground mb-1">
                Nama Project
              </label>
              <input
                id="detail-proj-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label htmlFor="detail-proj-desc" className="block text-xs font-medium text-foreground mb-1">
                Deskripsi
              </label>
              <textarea
                id="detail-proj-desc"
                rows={2}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div>
              <label htmlFor="detail-proj-status" className="block text-xs font-medium text-foreground mb-1">
                Status Operasional
              </label>
              <select
                id="detail-proj-status"
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
                <label htmlFor="detail-proj-rpm" className="block text-xs font-medium text-foreground mb-1">
                  Batas Request Per Menit (RPM)
                </label>
                <input
                  id="detail-proj-rpm"
                  type="number"
                  min={1}
                  required
                  value={rpmLimit}
                  onChange={(e) => setRpmLimit(parseInt(e.target.value, 10) || 1)}
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                />
                <p className="text-[11px] text-muted-foreground mt-1">Default gateway: 60 RPM</p>
              </div>

              <div>
                <label htmlFor="detail-proj-conc" className="block text-xs font-medium text-foreground mb-1">
                  Batas Concurrency (Slot Paralel)
                </label>
                <input
                  id="detail-proj-conc"
                  type="number"
                  min={1}
                  required
                  value={concurrencyLimit}
                  onChange={(e) => setConcurrencyLimit(parseInt(e.target.value, 10) || 1)}
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
                />
                <p className="text-[11px] text-muted-foreground mt-1">Default gateway: 5 slot</p>
              </div>
            </div>

            <div className="pt-3 border-t border-border flex justify-end">
              <Button type="submit" isLoading={isSavingConfig}>
                Simpan Perubahan
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Tab 2: API Keys */}
      {activeTab === 'keys' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              API key digunakan oleh aplikasi klien untuk mengakses endpoint OpenAI-compatible gateway.
            </p>
            <Button size="sm" onClick={() => setIsCreateKeyOpen(true)} className="gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              <span>Buat API Key</span>
            </Button>
          </div>

          {apiKeys.length === 0 ? (
            <div className="p-8 rounded-xl border border-border bg-card text-center space-y-3">
              <KeyRound className="w-8 h-8 text-muted-foreground mx-auto" />
              <h3 className="text-sm font-semibold text-foreground">Belum Ada API Key</h3>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                Klien tidak dapat mengakses endpoint inferensi sebelum API key dibuat untuk project ini.
              </p>
              <Button size="sm" onClick={() => setIsCreateKeyOpen(true)}>
                Buat API Key Pertama
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/80 text-muted-foreground border-b border-border">
                    <tr>
                      <th className="py-3 px-4">Nama Key</th>
                      <th className="py-3 px-4">Prefix Kunci</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Masa Berlaku</th>
                      <th className="py-3 px-4">Dibuat Pada</th>
                      <th className="py-3 px-4 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {apiKeys.map((k) => (
                      <tr key={k.id} className="hover:bg-muted/40 transition-colors">
                        <td className="py-3.5 px-4 font-medium text-foreground">{k.name}</td>
                        <td className="py-3.5 px-4 font-mono text-muted-foreground">{k.keyPrefix}...</td>
                        <td className="py-3.5 px-4">
                          <Badge variant={k.status === 'active' ? 'active' : 'revoked'}>
                            {k.status === 'active' ? 'Aktif' : 'Dicabut'}
                          </Badge>
                        </td>
                        <td className="py-3.5 px-4 text-muted-foreground">
                          {k.expiresAt
                            ? new Date(k.expiresAt).toLocaleDateString('id-ID')
                            : 'Tidak Kedaluwarsa'}
                        </td>
                        <td className="py-3.5 px-4 text-muted-foreground">
                          {new Date(k.createdAt).toLocaleDateString('id-ID')}
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          {k.status === 'active' ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setRevokingKey(k)}
                              className="text-red-400 hover:text-red-300 hover:bg-red-500/10 border-red-500/20"
                            >
                              Cabut
                            </Button>
                          ) : (
                            <span className="text-muted-foreground text-xs italic">Dicabut</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Model Aliases */}
      {activeTab === 'aliases' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Petakan alias publik yang dikirim klien (misal: `gemini-default`) ke kredensial Gemini aktif.
            </p>
            <Button size="sm" onClick={() => setIsCreateAliasOpen(true)} className="gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              <span>Tambah Model Alias</span>
            </Button>
          </div>

          {aliases.length === 0 ? (
            <div className="p-8 rounded-xl border border-border bg-card text-center space-y-3">
              <Layers className="w-8 h-8 text-muted-foreground mx-auto" />
              <h3 className="text-sm font-semibold text-foreground">Belum Ada Model Alias</h3>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                Tanpa alias model yang terikat ke kredensial aktif, request klien akan menghasilkan error HTTP 404 model_not_found.
              </p>
              <Button size="sm" onClick={() => setIsCreateAliasOpen(true)}>
                Ikat Model Alias Pertama
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/80 text-muted-foreground border-b border-border">
                    <tr>
                      <th className="py-3 px-4">Alias Publik</th>
                      <th className="py-3 px-4">Upstream Model</th>
                      <th className="py-3 px-4">Kredensial Terikat</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Dibuat Pada</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {aliases.map((a) => {
                      const boundCred = credentials.find((c) => c.id === a.boundCredentialId);
                      const isCredUnavailable = !boundCred || boundCred.status !== 'active';
                      return (
                        <tr key={a.id} className="hover:bg-muted/40 transition-colors">
                          <td className="py-3.5 px-4 font-mono font-medium text-foreground">{a.alias}</td>
                          <td className="py-3.5 px-4 font-mono text-muted-foreground">{a.upstreamModel}</td>
                          <td className="py-3.5 px-4">
                            {boundCred ? (
                              <div className="flex items-center gap-1.5">
                                <span>{boundCred.displayName}</span>
                                {isCredUnavailable && (
                                  <Badge variant="error" className="text-[10px]">
                                    Kredensial Nonaktif (503)
                                  </Badge>
                                )}
                              </div>
                            ) : (
                              <Badge variant="error">Kredensial Hilang (503)</Badge>
                            )}
                          </td>
                          <td className="py-3.5 px-4">
                            <Badge variant={a.status === 'active' ? 'active' : 'disabled'}>
                              {a.status === 'active' ? 'Aktif' : 'Nonaktif'}
                            </Badge>
                          </td>
                          <td className="py-3.5 px-4 text-muted-foreground">
                            {new Date(a.createdAt).toLocaleDateString('id-ID')}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 4: Provider Credentials */}
      {activeTab === 'credentials' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Kredensial Gemini API dienkripsi menggunakan AES-256-GCM. Secret tersimpan tidak pernah ditampilkan kembali.
            </p>
            <Button size="sm" onClick={() => setIsCreateCredOpen(true)} className="gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              <span>Tambah Kredensial Gemini</span>
            </Button>
          </div>

          {credentials.length === 0 ? (
            <div className="p-8 rounded-xl border border-border bg-card text-center space-y-3">
              <Cpu className="w-8 h-8 text-muted-foreground mx-auto" />
              <h3 className="text-sm font-semibold text-foreground">Belum Ada Kredensial Provider</h3>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                Daftarkan API key resmi Gemini dari Google AI Studio agar gateway dapat meneruskan inferensi AI.
              </p>
              <Button size="sm" onClick={() => setIsCreateCredOpen(true)}>
                Tambah Kredensial Gemini
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/80 text-muted-foreground border-b border-border">
                    <tr>
                      <th className="py-3 px-4">Display Name</th>
                      <th className="py-3 px-4">Provider</th>
                      <th className="py-3 px-4">Versi Kunci</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Max Concurrent</th>
                      <th className="py-3 px-4 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {credentials.map((c) => (
                      <tr key={c.id} className="hover:bg-muted/40 transition-colors">
                        <td className="py-3.5 px-4 font-medium text-foreground">{c.displayName}</td>
                        <td className="py-3.5 px-4">
                          <span className="font-mono text-xs capitalize">{c.provider}</span>
                        </td>
                        <td className="py-3.5 px-4 font-mono text-muted-foreground">
                          v{c.keyVersion}
                        </td>
                        <td className="py-3.5 px-4">
                          <Badge variant={c.status === 'active' ? 'active' : 'disabled'}>
                            {c.status === 'active' ? 'Aktif' : 'Nonaktif'}
                          </Badge>
                        </td>
                        <td className="py-3.5 px-4 font-mono text-muted-foreground">
                          {c.maxConcurrent ? `${c.maxConcurrent} slot` : 'Tak terbatas'}
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setRotatingCred(c)}
                            className="gap-1.5"
                          >
                            <RefreshCw className="w-3 h-3" />
                            <span>Rotasi Kunci</span>
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal: Create API Key with Sacred Modal */}
      <CreateApiKeyModal
        isOpen={isCreateKeyOpen}
        projectId={projectId}
        onClose={() => setIsCreateKeyOpen(false)}
        onSuccess={(newKey) => {
          setApiKeys((prev) => [newKey, ...prev]);
        }}
        fetchWithCsrf={fetchWithCsrf}
      />

      {/* Modal: Create Credential */}
      <CreateCredentialModal
        isOpen={isCreateCredOpen}
        projectId={projectId}
        onClose={() => setIsCreateCredOpen(false)}
        onSuccess={(newCred) => {
          setCredentials((prev) => [newCred, ...prev]);
        }}
        fetchWithCsrf={fetchWithCsrf}
      />

      {/* Modal: Rotate Key */}
      <RotateKeyModal
        isOpen={Boolean(rotatingCred)}
        projectId={projectId}
        credential={rotatingCred}
        onClose={() => setRotatingCred(null)}
        onSuccess={(updatedCred) => {
          setCredentials((prev) =>
            prev.map((c) => (c.id === updatedCred.id ? updatedCred : c))
          );
        }}
        fetchWithCsrf={fetchWithCsrf}
      />

      {/* Modal: Create Alias */}
      <CreateAliasModal
        isOpen={isCreateAliasOpen}
        projectId={projectId}
        credentials={credentials}
        onClose={() => setIsCreateAliasOpen(false)}
        onSuccess={(newAlias) => {
          setAliases((prev) => [newAlias, ...prev]);
        }}
        fetchWithCsrf={fetchWithCsrf}
      />

      {/* Revoke API Key Confirmation Dialog */}
      {revokingKey && (
        <Dialog
          isOpen={Boolean(revokingKey)}
          onClose={() => setRevokingKey(null)}
          title="Cabut API Key"
          description={`Apakah Anda yakin ingin mencabut '${revokingKey.name}' (${revokingKey.keyPrefix}...)? Request klien yang menggunakan key ini akan langsung ditolak (HTTP 401).`}
          maxWidth="max-w-md"
        >
          <div className="flex justify-end gap-3 pt-3 border-t border-border">
            <Button variant="outline" onClick={() => setRevokingKey(null)} disabled={isRevoking}>
              Batal
            </Button>
            <Button
              variant="destructive"
              isLoading={isRevoking}
              onClick={handleRevokeKey}
            >
              Ya, Cabut Key Sekarang
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export default function ProjectDetailPage({ params }: ProjectDetailPageProps) {
  const { id } = use(params);
  return (
    <AdminLayout title="Workspace Project">
      <ProjectDetailContent projectId={id} />
    </AdminLayout>
  );
}
