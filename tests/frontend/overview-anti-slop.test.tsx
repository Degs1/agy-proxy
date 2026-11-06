// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import OverviewPage from '@/app/admin/overview/page';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/overview',
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

// Mock admin-auth-context
const mockFetchWithCsrf = vi.fn();
vi.mock('@/context/admin-auth-context', () => ({
  AdminAuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAdminAuth: () => ({
    fetchWithCsrf: mockFetchWithCsrf,
    admin: { email: 'admin@internal.net', role: 'superadmin' },
    isLoading: false,
    logout: vi.fn(),
  }),
}));

describe('TASK-095: Overview Dashboard Telemetry Restructuring & Anti-Slop Layout', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders operational telemetry banner with Gateway node and Atlas ReplicaSet connectivity', async () => {
    mockFetchWithCsrf.mockImplementation((url: string) => {
      if (url === '/api/admin/projects') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              projects: [
                {
                  id: 'proj_1',
                  name: 'Enterprise Core',
                  status: 'active',
                  rpmLimit: 120,
                  concurrencyLimit: 10,
                  allowedModels: ['gemini-default'],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      if (url === '/api/admin/monitoring/summary') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              summary: {
                totalRequests: 4200,
                successfulRequests: 4180,
                failedRequests: 20,
                preauthRejections: { total: 15 },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    render(<OverviewPage />);

    // Check telemetry banner landmark
    const telemetryBanner = screen.getByRole('region', { name: /Status Telemetri Gateway/i });
    expect(telemetryBanner).toBeInTheDocument();

    const bannerScope = within(telemetryBanner);
    // Verify Gateway node status & active provider inside banner
    expect(bannerScope.getByText('Antigravity Gateway')).toBeInTheDocument();
    expect(bannerScope.getByText('Operational')).toBeInTheDocument();
    expect(bannerScope.getByText('MongoDB Atlas')).toBeInTheDocument();
    expect(bannerScope.getByText('ReplicaSet: Snapshot Isolation')).toBeInTheDocument();
    expect(bannerScope.getByText('Gemini API Resmi')).toBeInTheDocument();
    expect(bannerScope.getByText('Active MVP')).toBeInTheDocument();
  });

  it('renders 3 core metrics with visual hierarchy contrasting incident alert against standard counters', async () => {
    mockFetchWithCsrf.mockImplementation((url: string) => {
      if (url === '/api/admin/projects') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              projects: [
                {
                  id: 'proj_1',
                  name: 'Alpha Project',
                  status: 'active',
                  rpmLimit: 60,
                  concurrencyLimit: 5,
                  allowedModels: ['gemini-default'],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
                {
                  id: 'proj_2',
                  name: 'Beta Sandbox',
                  status: 'disabled',
                  rpmLimit: 30,
                  concurrencyLimit: 2,
                  allowedModels: ['gemini-default'],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      if (url === '/api/admin/monitoring/summary') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              summary: {
                totalRequests: 850,
                successfulRequests: 842,
                failedRequests: 8,
                preauthRejections: { total: 27 },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    render(<OverviewPage />);

    // Wait for project data to resolve
    await waitFor(() => {
      expect(screen.getByText('Alpha Project')).toBeInTheDocument();
    });

    // Metric 1: Total projects with tabular numbers
    const totalProjectsEl = screen.getByText('Total Project Terdaftar');
    expect(totalProjectsEl).toBeInTheDocument();
    const countProject = screen.getByText('2');
    expect(countProject.className).toContain('tabular-nums');

    // Metric 2: Gateway throughput with tabular numbers
    const throughputEl = screen.getByText('Total Permintaan Gateway');
    expect(throughputEl).toBeInTheDocument();
    const requestCount = screen.getByText('850');
    expect(requestCount.className).toContain('tabular-nums');

    // Metric 3: Incident / Rejection card with distinct warning accent and alert badge
    const alertLabel = screen.getByText('Penolakan Pra-Autentikasi');
    expect(alertLabel).toBeInTheDocument();
    expect(screen.getByText('Insiden')).toBeInTheDocument();
    const alertCount = screen.getByText('27');
    expect(alertCount.className).toContain('tabular-nums');
    expect(alertCount.className).toContain('text-amber-900');
  });

  it('renders quick view project table with tabular limits and manage links', async () => {
    mockFetchWithCsrf.mockImplementation((url: string) => {
      if (url === '/api/admin/projects') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              projects: [
                {
                  id: 'proj_xyz',
                  name: 'Production Gateway Client',
                  status: 'active',
                  rpmLimit: 300,
                  concurrencyLimit: 25,
                  allowedModels: ['gemini-default'],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      if (url === '/api/admin/monitoring/summary') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              summary: {
                totalRequests: 0,
                successfulRequests: 0,
                failedRequests: 0,
                preauthRejections: { total: 0 },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    render(<OverviewPage />);

    await waitFor(() => {
      expect(screen.getByText('Production Gateway Client')).toBeInTheDocument();
    });

    expect(screen.getByText(/Limit: 300 RPM \| 25 Concurrency/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Kelola$/i })).toHaveAttribute(
      'href',
      '/admin/projects/proj_xyz'
    );
  });
});
