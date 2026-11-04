// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import MonitoringPage from '@/app/admin/monitoring/page';
import {
  MonitoringSummary,
  MonitoringDetails,
  Project,
} from '@/lib/frontend/types';

// Mock Next.js navigation
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/monitoring',
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// Mock AdminAuthContext
const mockFetchWithCsrf = vi.fn();

vi.mock('@/context/admin-auth-context', () => ({
  AdminAuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAdminAuth: () => ({
    admin: { id: 'admin_1', email: 'admin@gateway.local', role: 'admin' },
    csrfToken: 'mock_csrf_token',
    isLoading: false,
    lockoutSeconds: 0,
    login: vi.fn(),
    logout: vi.fn(),
    refreshCsrf: vi.fn(),
    fetchWithCsrf: mockFetchWithCsrf,
  }),
}));

describe('Admin Monitoring UI: Summary, Details, Preauth Isolation & Zero Secret Leakage (TASK-072 / TASK-073)', () => {
  const mockProjects: Project[] = [
    {
      id: 'proj_alpha',
      name: 'Project Alpha',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: ['gemini-default'],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
    {
      id: 'proj_beta',
      name: 'Project Beta',
      status: 'active',
      rpmLimit: 120,
      concurrencyLimit: 10,
      allowedModels: ['gemini-flash'],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
  ];

  const mockSummary: MonitoringSummary = {
    totalRequests: 125,
    successfulRequests: 120,
    failedRequests: 5,
    averageDurationMs: 245.8,
    totalTokens: {
      promptTokens: 12500,
      completionTokens: 8400,
      totalTokens: 20900,
    },
    projects: [
      {
        projectId: 'proj_alpha',
        projectName: 'Project Alpha',
        totalRequests: 100,
        successfulRequests: 98,
        failedRequests: 2,
        promptTokens: 10000,
        completionTokens: 7000,
        totalTokens: 17000,
      },
      {
        projectId: 'proj_beta',
        projectName: 'Project Beta',
        totalRequests: 25,
        successfulRequests: 22,
        failedRequests: 3,
        promptTokens: 2500,
        completionTokens: 1400,
        totalTokens: 3900,
      },
    ],
    providers: [
      {
        provider: 'gemini',
        totalRequests: 125,
        successfulRequests: 120,
        failedRequests: 5,
        promptTokens: 12500,
        completionTokens: 8400,
        totalTokens: 20900,
      },
    ],
    preauthRejections: {
      total: 14,
    },
  };

  const mockDetails: MonitoringDetails = {
    total: 3,
    limit: 20,
    offset: 0,
    logs: [
      {
        id: 'log_1',
        requestId: 'req_measured_123',
        projectId: 'proj_alpha',
        projectName: 'Project Alpha',
        model: 'gemini-default',
        provider: 'gemini',
        statusCode: 200,
        durationMs: 312,
        result: 'success',
        errorCode: null,
        inputTokens: 150,
        outputTokens: 75,
        totalTokens: 225,
        streaming: false,
        createdAt: '2026-11-04T05:00:00.000Z',
      },
      {
        id: 'log_2',
        requestId: 'req_null_token_456',
        projectId: 'proj_beta',
        projectName: 'Project Beta',
        model: 'gemini-flash',
        provider: 'gemini',
        statusCode: 200,
        durationMs: 180,
        result: 'success',
        errorCode: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null, // CRITICAL: Token not measured / not available
        streaming: true,
        createdAt: '2026-11-04T05:05:00.000Z',
      },
      {
        id: 'log_3_preauth',
        requestId: 'req_preauth_789',
        projectId: null, // CRITICAL: Pre-auth rejection has NO project
        projectName: null,
        model: null,
        provider: null,
        statusCode: 401,
        durationMs: 5,
        result: 'error',
        errorCode: 'invalid_api_key',
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        streaming: false,
        createdAt: '2026-11-04T05:10:00.000Z',
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. Ringkasan Metrik & KPI Operasional (Summary Metrics)', () => {
    it('renders aggregate KPI cards with total requests, latency, tokens, and preauth rejections', async () => {
      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return Promise.resolve(new Response(JSON.stringify({ summary: mockSummary }), { status: 200 }));
        }
        if (url.includes('/api/admin/monitoring/details')) {
          return Promise.resolve(new Response(JSON.stringify(mockDetails), { status: 200 }));
        }
        if (url.includes('/api/admin/projects')) {
          return Promise.resolve(new Response(JSON.stringify({ projects: mockProjects }), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      render(<MonitoringPage />);

      // Verify page title
      expect(screen.getByText('Monitoring Operasional')).toBeInTheDocument();

      // Wait for data load
      await waitFor(() => {
        expect(screen.getByTestId('metric-total-requests')).toBeInTheDocument();
      });

      // KPI Card 1: Total Requests
      const totalReqCard = screen.getByTestId('metric-total-requests');
      expect(totalReqCard).toHaveTextContent('125');
      expect(totalReqCard).toHaveTextContent('120 sukses');
      expect(totalReqCard).toHaveTextContent('5 gagal');

      // KPI Card 2: Average Latency
      const latencyCard = screen.getByTestId('metric-avg-latency');
      expect(latencyCard).toHaveTextContent('245.8 ms');

      // KPI Card 3: Measured Tokens
      const tokenCard = screen.getByTestId('metric-total-tokens');
      expect(tokenCard).toHaveTextContent('20,900');
      expect(tokenCard).toHaveTextContent('Prompt: 12,500');
      expect(tokenCard).toHaveTextContent('Completion: 8,400');

      // KPI Card 4: Preauth Rejections
      const preauthCard = screen.getByTestId('metric-preauth-rejections');
      expect(preauthCard).toHaveTextContent('14');
      expect(preauthCard).toHaveTextContent('Terisolasi');
    });

    it('renders loading skeleton while data is fetching', async () => {
      let resolveSummaryPromise: (value: any) => void = () => {};
      const pendingPromise = new Promise((resolve) => {
        resolveSummaryPromise = resolve;
      });

      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return pendingPromise;
        }
        return Promise.resolve(new Response(JSON.stringify({ projects: [] }), { status: 200 }));
      });

      const { container } = render(<MonitoringPage />);

      // Check skeletons present
      const skeletons = container.querySelectorAll('.animate-pulse');
      expect(skeletons.length).toBeGreaterThan(0);

      // Resolve promise
      resolveSummaryPromise(new Response(JSON.stringify({ summary: mockSummary }), { status: 200 }));
    });

    it('displays error alert and retry button if API fails', async () => {
      mockFetchWithCsrf.mockRejectedValue(new Error('Koneksi database gagal'));

      render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText(/Gagal memuat data monitoring/i)).toBeInTheDocument();
      });

      const retryBtn = screen.getByRole('button', { name: /Coba Lagi/i });
      expect(retryBtn).toBeInTheDocument();
    });
  });

  describe('2. Rincian per Project dan Provider (Breakdown Telemetry)', () => {
    it('renders project breakdown with requests, successes, failures, and token counts', async () => {
      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return Promise.resolve(new Response(JSON.stringify({ summary: mockSummary }), { status: 200 }));
        }
        if (url.includes('/api/admin/monitoring/details')) {
          return Promise.resolve(new Response(JSON.stringify(mockDetails), { status: 200 }));
        }
        if (url.includes('/api/admin/projects')) {
          return Promise.resolve(new Response(JSON.stringify({ projects: mockProjects }), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByTestId('project-breakdown-table')).toBeInTheDocument();
      });

      const projectTable = screen.getByTestId('project-breakdown-table');
      expect(within(projectTable).getByText('Project Alpha')).toBeInTheDocument();
      expect(within(projectTable).getByText('Project Beta')).toBeInTheDocument();
      expect(within(projectTable).getByText('17,000')).toBeInTheDocument(); // Tokens Project Alpha
      expect(within(projectTable).getByText('3,900')).toBeInTheDocument();  // Tokens Project Beta
    });

    it('renders provider breakdown table with provider name and token telemetry', async () => {
      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return Promise.resolve(new Response(JSON.stringify({ summary: mockSummary }), { status: 200 }));
        }
        if (url.includes('/api/admin/monitoring/details')) {
          return Promise.resolve(new Response(JSON.stringify(mockDetails), { status: 200 }));
        }
        if (url.includes('/api/admin/projects')) {
          return Promise.resolve(new Response(JSON.stringify({ projects: mockProjects }), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByTestId('provider-breakdown-table')).toBeInTheDocument();
      });

      const providerTable = screen.getByTestId('provider-breakdown-table');
      expect(within(providerTable).getByText('gemini')).toBeInTheDocument();
      expect(within(providerTable).getByText('20,900')).toBeInTheDocument();
    });

    it('renders clean empty state when project or provider list is empty', async () => {
      const emptySummary: MonitoringSummary = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        averageDurationMs: 0,
        totalTokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        projects: [],
        providers: [],
        preauthRejections: { total: 0 },
      };

      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return Promise.resolve(new Response(JSON.stringify({ summary: emptySummary }), { status: 200 }));
        }
        if (url.includes('/api/admin/monitoring/details')) {
          return Promise.resolve(new Response(JSON.stringify({ logs: [], total: 0, limit: 20, offset: 0 }), { status: 200 }));
        }
        if (url.includes('/api/admin/projects')) {
          return Promise.resolve(new Response(JSON.stringify({ projects: [] }), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByText(/Belum ada data penggunaan project/i)).toBeInTheDocument();
        expect(screen.getByText(/Belum ada data provider/i)).toBeInTheDocument();
      });
    });
  });

  describe('3. Penanganan Token Terukur vs Data Token Tidak Tersedia ("N/A")', () => {
    it('displays measured token counts when available, and displays explicit "N/A" when token is null', async () => {
      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return Promise.resolve(new Response(JSON.stringify({ summary: mockSummary }), { status: 200 }));
        }
        if (url.includes('/api/admin/monitoring/details')) {
          return Promise.resolve(new Response(JSON.stringify(mockDetails), { status: 200 }));
        }
        if (url.includes('/api/admin/projects')) {
          return Promise.resolve(new Response(JSON.stringify({ projects: mockProjects }), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByTestId('log-row-req_measured_123')).toBeInTheDocument();
      });

      // Row 1: measured tokens (150 in, 75 out, 225 total)
      const measuredRow = screen.getByTestId('log-row-req_measured_123');
      expect(measuredRow).toHaveTextContent('225');

      // Row 2: token is null (stream or unmeasured) -> MUST display "N/A", NEVER display "0"
      const nullTokenRow = screen.getByTestId('log-row-req_null_token_456');
      expect(nullTokenRow).toHaveTextContent('N/A');
      // Assert that within the token cell of nullTokenRow, it does NOT say "0"
      const tokenCell = within(nullTokenRow).getByTestId('token-cell');
      expect(tokenCell).toHaveTextContent('N/A');
      expect(tokenCell).not.toHaveTextContent(/^0$/);
    });
  });

  describe('4. Isolasi Rejeksi Pra-Autentikasi (Preauth Isolation)', () => {
    it('isolates preauth rejections in a dedicated card and panel without false project attribution', async () => {
      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return Promise.resolve(new Response(JSON.stringify({ summary: mockSummary }), { status: 200 }));
        }
        if (url.includes('/api/admin/monitoring/details')) {
          return Promise.resolve(new Response(JSON.stringify(mockDetails), { status: 200 }));
        }
        if (url.includes('/api/admin/projects')) {
          return Promise.resolve(new Response(JSON.stringify({ projects: mockProjects }), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByTestId('preauth-isolation-panel')).toBeInTheDocument();
      });

      // Preauth isolation panel
      const preauthPanel = screen.getByTestId('preauth-isolation-panel');
      expect(preauthPanel).toHaveTextContent('Panel Isolasi Rejeksi Pra-Autentikasi');
      expect(preauthPanel).toHaveTextContent('14');
      expect(preauthPanel).toHaveTextContent(/tidak pernah diatribusikan ke project manapun/i);

      // Verify the preauth log row in details table
      const preauthRow = screen.getByTestId('log-row-req_preauth_789');
      expect(preauthRow).toBeInTheDocument();
      expect(preauthRow).toHaveTextContent('401');
      expect(preauthRow).toHaveTextContent('invalid_api_key');

      // Project cell in preauth row must show "N/A (Pra-Autentikasi)" or "-"
      const projectCell = within(preauthRow).getByTestId('project-cell');
      expect(projectCell).toHaveTextContent(/Pra-Autentikasi|N\/A|-/i);
      expect(projectCell).not.toHaveTextContent('Project Alpha');
      expect(projectCell).not.toHaveTextContent('Project Beta');
    });

    it('allows toggling between standard logs and pre-auth rejection logs', async () => {
      const preauthLogsOnly: MonitoringDetails = {
        total: 1,
        limit: 20,
        offset: 0,
        logs: [
          {
            id: 'log_preauth_only',
            requestId: 'req_preauth_isolated',
            projectId: null,
            projectName: null,
            model: null,
            provider: null,
            statusCode: 429,
            durationMs: 2,
            result: 'error',
            errorCode: 'preauth_rate_limit_exceeded',
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            streaming: false,
            createdAt: '2026-11-04T05:15:00.000Z',
          },
        ],
      };

      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return Promise.resolve(new Response(JSON.stringify({ summary: mockSummary }), { status: 200 }));
        }
        if (url.includes('type=preauth')) {
          return Promise.resolve(new Response(JSON.stringify(preauthLogsOnly), { status: 200 }));
        }
        if (url.includes('/api/admin/monitoring/details')) {
          return Promise.resolve(new Response(JSON.stringify(mockDetails), { status: 200 }));
        }
        if (url.includes('/api/admin/projects')) {
          return Promise.resolve(new Response(JSON.stringify({ projects: mockProjects }), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Log Pra-Autentikasi$/i })).toBeInTheDocument();
      });

      // Click on Pre-auth logs toggle button
      const preauthToggleBtn = screen.getByRole('button', { name: /^Log Pra-Autentikasi$/i });
      fireEvent.click(preauthToggleBtn);

      await waitFor(() => {
        expect(mockFetchWithCsrf).toHaveBeenCalledWith(
          expect.stringContaining('type=preauth')
        );
      });
    });
  });

  describe('5. Zero Secret Leakage Audit', () => {
    it('verifies that the DOM never leaks plaintext API keys, credentials, or prompt contents', async () => {
      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return Promise.resolve(new Response(JSON.stringify({ summary: mockSummary }), { status: 200 }));
        }
        if (url.includes('/api/admin/monitoring/details')) {
          return Promise.resolve(new Response(JSON.stringify(mockDetails), { status: 200 }));
        }
        if (url.includes('/api/admin/projects')) {
          return Promise.resolve(new Response(JSON.stringify({ projects: mockProjects }), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      const { container } = render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByTestId('metric-total-requests')).toBeInTheDocument();
      });

      const domHtml = container.innerHTML;

      // Assert ZERO plaintext API keys or credentials
      expect(domHtml).not.toContain('agw_live_');
      expect(domHtml).not.toContain('agw_secret_');
      expect(domHtml).not.toContain('AIzaSy');
      expect(domHtml).not.toContain('bearer ');
      expect(domHtml).not.toContain('authorization:');

      // Assert ZERO prompt or user message payload leakage
      expect(domHtml).not.toContain('messages');
      expect(domHtml).not.toContain('system prompt');
      expect(domHtml).not.toContain('user prompt');
      expect(domHtml).not.toContain('Halo gateway');
    });

    it('ensures injected raw payload content, bearer keys, and provider secrets in log data are never rendered', async () => {
      const contaminatedDetails = {
        total: 1,
        limit: 20,
        offset: 0,
        logs: [
          {
            id: 'log_leak_probe',
            requestId: 'req_safe_id_999',
            projectId: 'proj_alpha',
            projectName: 'Project Alpha',
            model: 'gemini-default',
            provider: 'gemini',
            statusCode: 200,
            durationMs: 120,
            result: 'success',
            errorCode: null,
            inputTokens: 50,
            outputTokens: 25,
            totalTokens: 75,
            streaming: false,
            createdAt: '2026-11-04T05:30:00.000Z',
            // Simulated contaminated backend response fields:
            apiKey: 'agw_live_secret_key_should_never_appear_123',
            credentialSecret: 'AIzaSy_fake_provider_credential_key_456',
            messages: [{ role: 'user', content: 'SECRET_USER_PROMPT_DO_NOT_LEAK' }],
            completionText: 'SECRET_AI_RESPONSE_DO_NOT_LEAK',
          },
        ],
      };

      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return Promise.resolve(new Response(JSON.stringify({ summary: mockSummary }), { status: 200 }));
        }
        if (url.includes('/api/admin/monitoring/details')) {
          return Promise.resolve(new Response(JSON.stringify(contaminatedDetails), { status: 200 }));
        }
        if (url.includes('/api/admin/projects')) {
          return Promise.resolve(new Response(JSON.stringify({ projects: mockProjects }), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      const { container } = render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByTestId('log-row-req_safe_id_999')).toBeInTheDocument();
      });

      const domHtml = container.innerHTML;

      expect(domHtml).not.toContain('agw_live_secret_key_should_never_appear_123');
      expect(domHtml).not.toContain('AIzaSy_fake_provider_credential_key_456');
      expect(domHtml).not.toContain('SECRET_USER_PROMPT_DO_NOT_LEAK');
      expect(domHtml).not.toContain('SECRET_AI_RESPONSE_DO_NOT_LEAK');
    });
  });

  describe('6. Filter & Interaktivitas', () => {
    it('supports filtering details by project', async () => {
      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return Promise.resolve(new Response(JSON.stringify({ summary: mockSummary }), { status: 200 }));
        }
        if (url.includes('/api/admin/monitoring/details')) {
          return Promise.resolve(new Response(JSON.stringify(mockDetails), { status: 200 }));
        }
        if (url.includes('/api/admin/projects')) {
          return Promise.resolve(new Response(JSON.stringify({ projects: mockProjects }), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Filter Project/i)).toBeInTheDocument();
      });

      const projectSelect = screen.getByLabelText(/Filter Project/i);
      fireEvent.change(projectSelect, { target: { value: 'proj_alpha' } });

      await waitFor(() => {
        expect(mockFetchWithCsrf).toHaveBeenCalledWith(
          expect.stringContaining('projectId=proj_alpha')
        );
      });
    });

    it('supports refresh action via button', async () => {
      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/api/admin/monitoring/summary')) {
          return Promise.resolve(new Response(JSON.stringify({ summary: mockSummary }), { status: 200 }));
        }
        if (url.includes('/api/admin/monitoring/details')) {
          return Promise.resolve(new Response(JSON.stringify(mockDetails), { status: 200 }));
        }
        if (url.includes('/api/admin/projects')) {
          return Promise.resolve(new Response(JSON.stringify({ projects: mockProjects }), { status: 200 }));
        }
        return Promise.reject(new Error(`Unhandled URL: ${url}`));
      });

      render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Segarkan Data/i })).toBeInTheDocument();
      });

      const refreshBtn = screen.getByRole('button', { name: /Segarkan Data/i });
      fireEvent.click(refreshBtn);

      await waitFor(() => {
        // Initial load called summary, details, projects (3 calls)
        // Refresh called summary, details, projects (3 calls) -> 6 calls total
        expect(mockFetchWithCsrf).toHaveBeenCalledTimes(6);
      });
    });
  });
});
