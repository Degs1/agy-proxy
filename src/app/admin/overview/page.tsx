'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AdminLayout } from '@/components/layout/admin-layout';
import { useAdminAuth } from '@/context/admin-auth-context';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  FolderKanban,
  Cpu,
  ShieldAlert,
  Activity,
  ArrowRight,
  Plus,
} from 'lucide-react';
import { Project } from '@/lib/frontend/types';

function OverviewContent() {
  const { fetchWithCsrf } = useAdminAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetchWithCsrf('/api/admin/projects');
      if (res.ok) {
        const d = await res.json();
        setProjects(d.projects || []);
      }
    } finally {
      setIsLoading(false);
    }
  }, [fetchWithCsrf]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const activeProjectsCount = projects.filter((p) => p.status === 'active').length;

  return (
    <div className="space-y-6">
      {/* Overview Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Ringkasan Sistem</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Status operasional Antigravity Gateway, multi-project, dan telemetri koneksi Atlas.
          </p>
        </div>
        <Link href="/admin/projects">
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            <span>Kelola Project</span>
          </Button>
        </Link>
      </div>

      {/* 4 Bento Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Total Projects */}
        <div className="p-5 rounded-lg border border-border bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Total Project</span>
            <FolderKanban className="w-4 h-4 text-primary" />
          </div>
          {isLoading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-foreground font-mono">{projects.length}</span>
              <span className="text-xs text-muted-foreground">({activeProjectsCount} aktif)</span>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Workspace terisolasi per project</p>
        </div>

        {/* Card 2: Active Provider */}
        <div className="p-5 rounded-lg border border-border bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">AI Provider Aktif</span>
            <Cpu className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-foreground">Gemini API Resmi</span>
          </div>
          <p className="text-[11px] text-emerald-400 flex items-center gap-1">
            <Badge variant="active" showIcon={false} className="py-0 px-1.5 text-[10px]">
              Active MVP
            </Badge>
            <span>AES-256-GCM Terenkripsi</span>
          </p>
        </div>

        {/* Card 3: Gateway Health */}
        <div className="p-5 rounded-lg border border-border bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Koneksi Database</span>
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold text-foreground">Atlas ReplicaSet</span>
          </div>
          <p className="text-[11px] text-muted-foreground">Snapshot isolation & atomik lease</p>
        </div>

        {/* Card 4: Global Pre-Auth Rejections */}
        <div className="p-5 rounded-lg border border-border bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Penolakan Pra-Autentikasi</span>
            <ShieldAlert className="w-4 h-4 text-yellow-500" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-foreground font-mono">0</span>
            <span className="text-xs text-muted-foreground">(Global)</span>
          </div>
          <p className="text-[11px] text-muted-foreground">Penolakan token salah / tanpa project</p>
        </div>
      </div>

      {/* Projects Quick View */}
      <div className="rounded-lg border border-border bg-card p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">Daftar Project Terdaftar</h2>
            <p className="text-xs text-muted-foreground">Akses cepat ke detail project dan alokasi batas</p>
          </div>
          <Link
            href="/admin/projects"
            className="text-xs font-medium text-primary hover:underline flex items-center gap-1"
          >
            <span>Buka Semua</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-8 text-xs text-muted-foreground">
            Belum ada project terdaftar.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {projects.slice(0, 5).map((p) => (
              <div key={p.id} className="py-3 flex items-center justify-between gap-4">
                <div>
                  <Link
                    href={`/admin/projects/${p.id}`}
                    className="text-sm font-semibold text-foreground hover:text-primary transition-colors"
                  >
                    {p.name}
                  </Link>
                  <p className="text-xs text-muted-foreground font-mono">
                    Limit: {p.rpmLimit} RPM | {p.concurrencyLimit} Concurrency
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={p.status === 'active' ? 'active' : 'disabled'}>
                    {p.status === 'active' ? 'Aktif' : 'Nonaktif'}
                  </Badge>
                  <Link
                    href={`/admin/projects/${p.id}`}
                    className="text-xs text-primary hover:bg-primary/10 px-2 py-1 rounded transition-colors"
                  >
                    Kelola
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function OverviewPage() {
  return (
    <AdminLayout title="Overview Gateway">
      <OverviewContent />
    </AdminLayout>
  );
}
