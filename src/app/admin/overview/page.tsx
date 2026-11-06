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
  Server,
  Database,
} from 'lucide-react';
import { Project } from '@/lib/frontend/types';

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'error' | 'loading';
  database: string;
  indexes: string;
}

interface TelemetryStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  preauthRejections: number;
}

function OverviewContent() {
  const { fetchWithCsrf } = useAdminAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [health, setHealth] = useState<HealthStatus>({
    status: 'healthy',
    database: 'connected',
    indexes: 'ready',
  });
  const [telemetry, setTelemetry] = useState<TelemetryStats>({
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    preauthRejections: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [projRes, healthRes, summaryRes] = await Promise.allSettled([
        fetchWithCsrf('/api/admin/projects'),
        fetch('/api/health'),
        fetchWithCsrf('/api/admin/monitoring/summary'),
      ]);

      if (projRes.status === 'fulfilled' && projRes.value.ok) {
        const d = await projRes.value.json();
        setProjects(d.projects || []);
      }

      if (healthRes.status === 'fulfilled' && healthRes.value.ok) {
        const h = await healthRes.value.json();
        setHealth({
          status: h.status || 'healthy',
          database: h.database || 'connected',
          indexes: h.indexes || 'ready',
        });
      }

      if (summaryRes.status === 'fulfilled' && summaryRes.value.ok) {
        const s = await summaryRes.value.json();
        if (s.summary) {
          setTelemetry({
            totalRequests: s.summary.totalRequests || 0,
            successfulRequests: s.summary.successfulRequests || 0,
            failedRequests: s.summary.failedRequests || 0,
            preauthRejections: s.summary.preauthRejections?.total || 0,
          });
        }
      }
    } catch {
      // Keep existing state or default safe fallbacks
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

      {/* Telemetry Status Banner (Baris Atas Zona Status) */}
      <section
        aria-label="Status Telemetri Gateway"
        className="rounded-lg border border-border/80 bg-card p-4 sm:p-5 shadow-sm"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          {/* Gateway Status Node */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-md bg-muted border border-border/80 flex items-center justify-center shrink-0">
              <Server className="w-4 h-4 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-foreground tracking-wide">
                  Antigravity Gateway
                </span>
                <Badge
                  variant={health.status === 'degraded' ? 'warning' : 'active'}
                  showIcon={true}
                  className="py-0 px-1.5 text-[10px]"
                >
                  {health.status === 'degraded' ? 'Degraded' : 'Operational'}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Next.js App Router: Edge Dispatch & Rate Limit Coordinator
              </p>
            </div>
          </div>

          {/* Telemetry Pillars: Database & AI Provider */}
          <div className="flex flex-wrap items-center gap-4 sm:gap-6 pt-3 lg:pt-0 border-t lg:border-t-0 border-border/60">
            {/* Pillar 1: Atlas ReplicaSet */}
            <div className="flex items-center gap-2.5">
              <Database className="w-4 h-4 text-emerald-500 shrink-0" />
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-foreground">MongoDB Atlas</span>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                </div>
                <p className="text-[10px] text-muted-foreground font-mono">
                  ReplicaSet: Snapshot Isolation
                </p>
              </div>
            </div>

            <div className="hidden sm:block w-px h-8 bg-border/60" />

            {/* Pillar 2: Active Provider */}
            <div className="flex items-center gap-2.5">
              <Cpu className="w-4 h-4 text-primary shrink-0" />
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-foreground">Gemini API Resmi</span>
                  <Badge variant="active" showIcon={false} className="py-0 px-1.5 text-[10px]">
                    Active MVP
                  </Badge>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  AES-256-GCM Terenkripsi
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3 Core Metric Cards with Visual Contrast & Hierarchy */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Metric 1: Total & Active Projects (Standard Metric) */}
        <div className="p-5 rounded-lg border border-border/80 bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium text-foreground">Total Project Terdaftar</span>
            <FolderKanban className="w-4 h-4 text-primary" />
          </div>
          {isLoading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-foreground font-mono tabular-nums">
                {projects.length}
              </span>
              <span className="text-xs text-muted-foreground font-mono tabular-nums">
                ({activeProjectsCount} aktif)
              </span>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Workspace terisolasi per project</p>
        </div>

        {/* Metric 2: Gateway Request Throughput (Standard Metric) */}
        <div className="p-5 rounded-lg border border-border/80 bg-card shadow-sm space-y-2">
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium text-foreground">Total Permintaan Gateway</span>
            <Activity className="w-4 h-4 text-emerald-500" />
          </div>
          {isLoading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-foreground font-mono tabular-nums">
                {telemetry.totalRequests}
              </span>
              <span className="text-xs text-muted-foreground font-mono tabular-nums">
                ({telemetry.successfulRequests} sukses)
              </span>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Agregasi stream SSE & non-stream completion</p>
        </div>

        {/* Metric 3: Incident / Rejection Alert Card (Warning Accent & Visual Distinction) */}
        <div className="p-5 rounded-lg border border-amber-500/40 bg-amber-500/5 dark:border-amber-500/30 dark:bg-amber-500/10 shadow-sm space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-amber-800 dark:text-amber-300">
              Penolakan Pra-Autentikasi
            </span>
            <div className="flex items-center gap-1.5">
              <Badge variant="warning" showIcon={false} className="py-0 px-1.5 text-[10px]">
                Insiden
              </Badge>
              <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            </div>
          </div>
          {isLoading ? (
            <Skeleton className="h-8 w-16" />
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-amber-900 dark:text-amber-200 font-mono tabular-nums">
                {telemetry.preauthRejections}
              </span>
              <span className="text-xs text-amber-700 dark:text-amber-400 font-medium">(Global)</span>
            </div>
          )}
          <p className="text-[11px] text-amber-700/90 dark:text-amber-400/90 leading-tight">
            Penolakan API key salah, revocated, atau tanpa project
          </p>
        </div>
      </div>

      {/* Projects Quick View */}
      <div className="rounded-lg border border-border/80 bg-card p-6 shadow-sm space-y-4">
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
                  <p className="text-xs text-muted-foreground font-mono tabular-nums">
                    Limit: {p.rpmLimit} RPM | {p.concurrencyLimit} Concurrency
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={p.status === 'active' ? 'active' : 'disabled'}>
                    {p.status === 'active' ? 'Aktif' : 'Nonaktif'}
                  </Badge>
                  <Link
                    href={`/admin/projects/${p.id}`}
                    className="text-xs text-primary hover:bg-primary/10 px-2 py-1 rounded-md transition-colors"
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
