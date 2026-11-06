'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/layout/admin-layout';
import { useAdminAuth } from '@/context/admin-auth-context';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Activity,
  Clock,
  Cpu,
  ShieldAlert,
  RefreshCw,
  AlertCircle,
  Filter,
  ChevronLeft,
  ChevronRight,
  Server,
  Layers,
  Database,
} from 'lucide-react';
import {
  MonitoringSummary,
  MonitoringDetails,
  MonitoringLogItem,
  Project,
} from '@/lib/frontend/types';

function MonitoringContent() {
  const { fetchWithCsrf } = useAdminAuth();

  // State
  const [summary, setSummary] = useState<MonitoringSummary | null>(null);
  const [details, setDetails] = useState<MonitoringDetails | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isPageLoading, setIsPageLoading] = useState(true);
  const [isLogsLoading, setIsLogsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Filters
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [selectedStatus, setSelectedStatus] = useState<string>('');
  const [logType, setLogType] = useState<'all' | 'preauth'>('all');
  const [offset, setOffset] = useState<number>(0);
  const limit = 20;

  // Load summary and projects list (runs on mount or explicit refresh)
  const loadSummaryAndProjects = useCallback(async () => {
    try {
      const [sumRes, projRes] = await Promise.all([
        fetchWithCsrf('/api/admin/monitoring/summary'),
        fetchWithCsrf('/api/admin/projects'),
      ]);

      if (!sumRes.ok) {
        throw new Error(`Summary API error: ${sumRes.statusText}`);
      }
      const sumData = await sumRes.json();
      setSummary(sumData.summary);

      if (projRes.ok) {
        const projData = await projRes.json();
        setProjects(projData.projects || []);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Gagal memuat data monitoring');
    }
  }, [fetchWithCsrf]);

  // Load log details with filters and pagination
  const fetchDetails = useCallback(async () => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    if (logType === 'preauth') {
      params.set('type', 'preauth');
    } else {
      if (selectedProjectId) params.set('projectId', selectedProjectId);
      if (selectedProvider) params.set('provider', selectedProvider);
      if (selectedStatus) params.set('status', selectedStatus);
    }

    const res = await fetchWithCsrf(`/api/admin/monitoring/details?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Details API error: ${res.statusText}`);
    }
    return res.json();
  }, [fetchWithCsrf, limit, offset, logType, selectedProjectId, selectedProvider, selectedStatus]);

  // Initial load for Summary & Projects
  useEffect(() => {
    let active = true;
    setIsPageLoading(true);
    loadSummaryAndProjects().finally(() => {
      if (active) {
        setIsPageLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [loadSummaryAndProjects]);

  // Load log details when filters or pagination change
  useEffect(() => {
    let active = true;
    setIsLogsLoading(true);
    fetchDetails()
      .then((data) => {
        if (active) {
          setDetails(data);
        }
      })
      .catch((err: any) => {
        if (active) {
          setErrorMessage(err.message || 'Gagal memuat riwayat log');
        }
      })
      .finally(() => {
        if (active) {
          setIsLogsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [fetchDetails]);

  // Handle Refresh
  const handleRefresh = async () => {
    setIsRefreshing(true);
    setErrorMessage(null);
    try {
      await Promise.all([
        loadSummaryAndProjects(),
        fetchDetails()
          .then((data) => setDetails(data))
          .catch((err) => {
            setErrorMessage(err.message || 'Gagal memuat riwayat log');
          }),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  // Handle Retry after failure
  const handleRetry = async () => {
    setErrorMessage(null);
    setIsPageLoading(true);
    setIsLogsLoading(true);
    try {
      await Promise.all([
        loadSummaryAndProjects().finally(() => setIsPageLoading(false)),
        fetchDetails()
          .then((data) => setDetails(data))
          .catch((err) => {
            setErrorMessage(err.message || 'Gagal memuat riwayat log');
          })
          .finally(() => setIsLogsLoading(false)),
      ]);
    } catch (err: any) {
      setErrorMessage(err.message || 'Gagal memuat data monitoring');
    }
  };

  // Helper formatting
  const formatNumber = (num: number | null | undefined): string => {
    if (num === null || num === undefined) return '-';
    return num.toLocaleString();
  };

  const formatTimestamp = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' ' + d.toLocaleDateString();
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Monitoring Operasional</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Metrik agregat, telemetri token, rincian per-project & provider, serta penolakan pra-autentikasi.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={handleRefresh}
            variant="outline"
            className="gap-2 min-h-[44px]"
            disabled={isRefreshing || isPageLoading}
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            <span>Segarkan Data</span>
          </Button>
        </div>
      </div>

      {/* Error Banner */}
      {errorMessage && (
        <div className="p-4 rounded-lg border border-destructive/30 bg-destructive/10 text-destructive flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>Gagal memuat data monitoring: {errorMessage}</span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleRetry}
            className="text-xs min-h-[36px]"
          >
            Coba Lagi
          </Button>
        </div>
      )}

      {/* 4 Primary KPI Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Total Requests */}
        <div
          data-testid="metric-total-requests"
          className="p-5 rounded-lg border border-border bg-card shadow-sm space-y-2"
        >
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Total Permintaan</span>
            <Activity className="w-4 h-4 text-primary" />
          </div>
          {isPageLoading || !summary ? (
            <Skeleton className="h-8 w-20" />
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-foreground font-mono tabular-nums">
                {summary.totalRequests.toLocaleString()}
              </span>
            </div>
          )}
          {summary ? (
            <p className="text-[11px] text-muted-foreground">
              <span className="text-emerald-400 font-medium font-mono tabular-nums">{summary.successfulRequests.toLocaleString()} sukses</span>
              {' · '}
              <span className={`font-mono tabular-nums ${summary.failedRequests > 0 ? 'text-red-400 font-medium' : ''}`}>
                {summary.failedRequests.toLocaleString()} gagal
              </span>
            </p>
          ) : (
            <Skeleton className="h-4 w-32" />
          )}
        </div>

        {/* Card 2: Average Latency */}
        <div
          data-testid="metric-avg-latency"
          className="p-5 rounded-lg border border-border bg-card shadow-sm space-y-2"
        >
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Rata-rata Latensi</span>
            <Clock className="w-4 h-4 text-sky-400" />
          </div>
          {isPageLoading || !summary ? (
            <Skeleton className="h-8 w-20" />
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-foreground font-mono tabular-nums">
                {summary.averageDurationMs.toFixed(1)} ms
              </span>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Waktu pemrosesan gateway</p>
        </div>

        {/* Card 3: Measured Tokens */}
        <div
          data-testid="metric-total-tokens"
          className="p-5 rounded-lg border border-border bg-card shadow-sm space-y-2"
        >
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Penggunaan Token Terukur</span>
            <Cpu className="w-4 h-4 text-emerald-400" />
          </div>
          {isPageLoading || !summary ? (
            <Skeleton className="h-8 w-20" />
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-foreground font-mono tabular-nums">
                {summary.totalTokens.totalTokens.toLocaleString()}
              </span>
            </div>
          )}
          {summary ? (
            <p className="text-[11px] text-muted-foreground truncate">
              Prompt: <span className="font-mono tabular-nums">{summary.totalTokens.promptTokens.toLocaleString()}</span> · Completion: <span className="font-mono tabular-nums">{summary.totalTokens.completionTokens.toLocaleString()}</span>
            </p>
          ) : (
            <Skeleton className="h-4 w-32" />
          )}
        </div>

        {/* Card 4: Preauth Rejections */}
        <div
          data-testid="metric-preauth-rejections"
          className="p-5 rounded-lg border border-border bg-card shadow-sm space-y-2"
        >
          <div className="flex items-center justify-between text-muted-foreground">
            <span className="text-xs font-medium">Penolakan Pra-Autentikasi</span>
            <ShieldAlert className="w-4 h-4 text-yellow-500" />
          </div>
          {isPageLoading || !summary ? (
            <Skeleton className="h-8 w-20" />
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-2xl font-bold text-foreground font-mono tabular-nums">
                {summary.preauthRejections.total.toLocaleString()}
              </span>
              <Badge variant="warning" showIcon={false} className="text-[10px] px-1.5 py-0">
                Terisolasi
              </Badge>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">401 / 429 Tanpa atribusi project</p>
        </div>
      </div>

      {/* Pre-auth Rejection Isolation Panel */}
      <div
        data-testid="preauth-isolation-panel"
        className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-5 shadow-sm space-y-3"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-yellow-500/20 text-yellow-400 flex items-center justify-center shrink-0 mt-0.5">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Panel Isolasi Rejeksi Pra-Autentikasi
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                Penolakan pada gateway sebelum identitas terverifikasi (kunci tidak valid atau rate limit IP global). Catatan ini tidak pernah diatribusikan ke project manapun.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <span className="text-xl font-bold text-yellow-400 font-mono tabular-nums">
                {summary ? summary.preauthRejections.total.toLocaleString() : '0'}
              </span>
              <p className="text-[10px] text-muted-foreground">Total Penolakan</p>
            </div>
            <Button
              size="sm"
              variant={logType === 'preauth' ? 'primary' : 'outline'}
              className="text-xs min-h-[44px]"
              onClick={() => {
                setLogType('preauth');
                setOffset(0);
              }}
            >
              Lihat Log Pra-Autentikasi
            </Button>
          </div>
        </div>
      </div>

      {/* Breakdown Section: Projects and Providers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Project Breakdown */}
        <div
          data-testid="project-breakdown-table"
          className="rounded-lg border border-border bg-card p-5 shadow-sm space-y-4"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Rincian per Project</h2>
            </div>
            <span className="text-xs text-muted-foreground font-mono tabular-nums">
              {summary?.projects.length || 0} Project
            </span>
          </div>

          {isPageLoading || !summary ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : summary.projects.length === 0 ? (
            <div className="text-center py-8 text-xs text-muted-foreground">
              Belum ada data penggunaan project.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <tr>
                    <th className="py-2.5 px-3">Project</th>
                    <th className="py-2.5 px-3 text-right">Permintaan</th>
                    <th className="py-2.5 px-3 text-right">Sukses / Gagal</th>
                    <th className="py-2.5 px-3 text-right">Total Token</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {summary.projects.map((p) => (
                    <tr key={p.projectId} className="hover:bg-muted/40 transition-colors">
                      <td className="py-2.5 px-3 font-medium text-foreground">
                        {p.projectName}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                        {p.totalRequests.toLocaleString()}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                        <span className="text-emerald-400">{p.successfulRequests.toLocaleString()}</span>
                        {' / '}
                        <span className={p.failedRequests > 0 ? 'text-red-400' : 'text-muted-foreground'}>
                          {p.failedRequests.toLocaleString()}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums font-medium text-foreground">
                        {p.totalTokens.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Provider Breakdown */}
        <div
          data-testid="provider-breakdown-table"
          className="rounded-lg border border-border bg-card p-5 shadow-sm space-y-4"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-emerald-400" />
              <h2 className="text-sm font-semibold text-foreground">Rincian per Provider</h2>
            </div>
            <span className="text-xs text-muted-foreground font-mono tabular-nums">
              {summary?.providers.length || 0} Provider
            </span>
          </div>

          {isPageLoading || !summary ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : summary.providers.length === 0 ? (
            <div className="text-center py-8 text-xs text-muted-foreground">
              Belum ada data provider.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead className="text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border">
                  <tr>
                    <th className="py-2.5 px-3">Provider</th>
                    <th className="py-2.5 px-3 text-right">Permintaan</th>
                    <th className="py-2.5 px-3 text-right">Sukses / Gagal</th>
                    <th className="py-2.5 px-3 text-right">Total Token</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {summary.providers.map((pr) => (
                    <tr key={pr.provider} className="hover:bg-muted/40 transition-colors">
                      <td className="py-2.5 px-3 font-medium text-foreground capitalize">
                        {pr.provider}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                        {pr.totalRequests.toLocaleString()}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                        <span className="text-emerald-400">{pr.successfulRequests.toLocaleString()}</span>
                        {' / '}
                        <span className={pr.failedRequests > 0 ? 'text-red-400' : 'text-muted-foreground'}>
                          {pr.failedRequests.toLocaleString()}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums font-medium text-foreground">
                        {pr.totalTokens.toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Detailed Request Logs */}
      <div className="rounded-lg border border-border bg-card p-5 shadow-sm space-y-4">
        {/* Header & Filter Controls */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 border-b border-border pb-4">
          <div>
            <h2 className="text-base font-semibold text-foreground">Riwayat Log Request</h2>
            <p className="text-xs text-muted-foreground">
              Telemetri audit operasional tanpa kebocoran secret atau payload prompt pengguna.
            </p>
          </div>

          {/* Toggle Type buttons */}
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md border border-border bg-muted/30 p-1">
              <button
                type="button"
                onClick={() => {
                  setLogType('all');
                  setOffset(0);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors min-h-[36px] ${
                  logType === 'all'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Semua Log
              </button>
              <button
                type="button"
                onClick={() => {
                  setLogType('preauth');
                  setOffset(0);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors min-h-[36px] ${
                  logType === 'preauth'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Log Pra-Autentikasi
              </button>
            </div>
          </div>
        </div>

        {/* Filters bar (only relevant when logType is 'all') */}
        {logType === 'all' && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
            {/* Project Filter */}
            <div>
              <label htmlFor="filter-project" className="block text-[11px] font-medium text-muted-foreground mb-1">
                Filter Project
              </label>
              <select
                id="filter-project"
                aria-label="Filter Project"
                value={selectedProjectId}
                onChange={(e) => {
                  setSelectedProjectId(e.target.value);
                  setOffset(0);
                }}
                className="w-full h-10 px-3 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary min-h-[44px]"
              >
                <option value="">Semua Project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Provider Filter */}
            <div>
              <label htmlFor="filter-provider" className="block text-[11px] font-medium text-muted-foreground mb-1">
                Filter Provider
              </label>
              <select
                id="filter-provider"
                aria-label="Filter Provider"
                value={selectedProvider}
                onChange={(e) => {
                  setSelectedProvider(e.target.value);
                  setOffset(0);
                }}
                className="w-full h-10 px-3 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary min-h-[44px]"
              >
                <option value="">Semua Provider</option>
                {Array.from(
                  new Set(['gemini', ...(summary?.providers?.map((p) => p.provider) || [])])
                ).map((prov) => (
                  <option key={prov} value={prov}>
                    {prov.charAt(0).toUpperCase() + prov.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            {/* Status Filter */}
            <div>
              <label htmlFor="filter-status" className="block text-[11px] font-medium text-muted-foreground mb-1">
                Filter Status
              </label>
              <select
                id="filter-status"
                aria-label="Filter Status"
                value={selectedStatus}
                onChange={(e) => {
                  setSelectedStatus(e.target.value);
                  setOffset(0);
                }}
                className="w-full h-10 px-3 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary min-h-[44px]"
              >
                <option value="">Semua Status</option>
                <option value="success">Sukses (2xx)</option>
                <option value="error">Error (4xx/5xx)</option>
                <option value="cancelled">Dibatalkan</option>
                <option value="timeout">Timeout</option>
              </select>
            </div>
          </div>
        )}

        {/* Logs Table */}
        {isLogsLoading || !details ? (
          <div className="space-y-2 py-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : details.logs.length === 0 ? (
          <div className="text-center py-12 text-xs text-muted-foreground">
            Belum ada riwayat aktivitas request tercatat.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border bg-muted/20">
                <tr>
                  <th className="py-2.5 px-3">Waktu</th>
                  <th className="py-2.5 px-3">Request ID</th>
                  <th className="py-2.5 px-3">Project</th>
                  <th className="py-2.5 px-3">Model / Provider</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3 text-right">Durasi</th>
                  <th className="py-2.5 px-3 text-right">Token</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {details.logs.map((log: MonitoringLogItem) => {
                  const isPreauth = log.projectId === null;
                  const isSuccess = log.statusCode >= 200 && log.statusCode < 300;
                  const isRateLimit = log.statusCode === 429;

                  return (
                    <tr
                      key={log.id}
                      data-testid={`log-row-${log.requestId || log.id}`}
                      className="hover:bg-muted/40 transition-colors"
                    >
                      {/* Timestamp */}
                      <td className="py-3 px-3 text-muted-foreground whitespace-nowrap font-mono tabular-nums">
                        {formatTimestamp(log.createdAt)}
                      </td>

                      {/* Request ID */}
                      <td className="py-3 px-3 font-mono text-[11px] text-foreground whitespace-nowrap">
                        {log.requestId ? log.requestId.slice(0, 16) : '-'}
                      </td>

                      {/* Project Cell */}
                      <td data-testid="project-cell" className="py-3 px-3">
                        {isPreauth ? (
                          <Badge variant="warning" showIcon={false} className="text-[10px] py-0 px-1.5">
                            N/A (Pra-Autentikasi)
                          </Badge>
                        ) : (
                          <span className="font-medium text-foreground">
                            {log.projectName || log.projectId}
                          </span>
                        )}
                      </td>

                      {/* Model & Provider */}
                      <td className="py-3 px-3 text-muted-foreground whitespace-nowrap">
                        {log.model ? (
                          <div className="flex flex-col">
                            <span className="text-foreground font-mono text-[11px]">{log.model}</span>
                            <span className="text-[10px] text-muted-foreground capitalize">{log.provider || 'gemini'}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>

                      {/* Status & Error */}
                      <td className="py-3 px-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <Badge
                            variant={isSuccess ? 'active' : isRateLimit ? 'warning' : 'error'}
                            showIcon={false}
                            className="font-mono text-[11px] py-0 px-1.5"
                          >
                            {log.statusCode}
                          </Badge>
                          {log.errorCode && (
                            <span className="text-[10px] text-muted-foreground font-mono">
                              {log.errorCode}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Duration */}
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                        {log.durationMs} ms
                      </td>

                      {/* Token Cell (CRITICAL: If null, displays N/A, NEVER 0) */}
                      <td data-testid="token-cell" className="py-3 px-3 text-right whitespace-nowrap">
                        {log.totalTokens === null ? (
                          <Badge variant="disabled" showIcon={false} className="text-[10px] py-0 px-1.5 font-mono">
                            N/A
                          </Badge>
                        ) : (
                          <div className="flex flex-col items-end">
                            <span className="font-mono tabular-nums font-medium text-foreground">
                              {log.totalTokens.toLocaleString()}
                            </span>
                            <span className="text-[10px] text-muted-foreground font-mono tabular-nums">
                              {formatNumber(log.inputTokens)} in / {formatNumber(log.outputTokens)} out
                            </span>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination Controls */}
        {details && details.total > 0 && (
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 border-t border-border">
            <span className="text-xs text-muted-foreground">
              Menampilkan <span className="font-mono tabular-nums">{details.total === 0 ? 0 : offset + 1}</span> - <span className="font-mono tabular-nums">{Math.min(offset + limit, details.total)}</span> dari <span className="font-mono tabular-nums">{details.total}</span> log
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset((prev) => Math.max(0, prev - limit))}
                disabled={offset === 0 || isLogsLoading}
                className="gap-1 min-h-[44px]"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>Sebelumnya</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset((prev) => prev + limit)}
                disabled={offset + limit >= details.total || isLogsLoading}
                className="gap-1 min-h-[44px]"
              >
                <span>Selanjutnya</span>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MonitoringPage() {
  return (
    <AdminLayout title="Monitoring Gateway">
      <MonitoringContent />
    </AdminLayout>
  );
}
