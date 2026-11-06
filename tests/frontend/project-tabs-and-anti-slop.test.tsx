// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import ProjectDetailPage from '@/app/admin/projects/[id]/page';
import { ConnectAntigravityModal } from '@/components/credentials/connect-antigravity-modal';
import MonitoringPage from '@/app/admin/monitoring/page';
import { MonitoringSummary, MonitoringDetails, Project } from '@/lib/frontend/types';

// Mock Next.js navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/projects/proj_test',
  useRouter: () => ({
    push: mockPush,
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

describe('TASK-096: ARIA Tab Semantics, Functional Icons, and Tabular Typography (F-03, F-04, F-05)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mockProjectData = {
    project: {
      id: 'proj_test_123',
      name: 'Nexus Gateway Alpha',
      description: 'Production workspace for AI routing',
      status: 'active',
      rpmLimit: 60,
      concurrencyLimit: 5,
      allowedModels: ['gemini-default'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };

  const setupProjectDetail = async () => {
    mockFetchWithCsrf.mockImplementation((url: string) => {
      if (url.includes('/keys')) {
        return Promise.resolve(
          new Response(JSON.stringify({ keys: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      if (url.includes('/credentials')) {
        return Promise.resolve(
          new Response(JSON.stringify({ credentials: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      if (url.includes('/aliases')) {
        return Promise.resolve(
          new Response(JSON.stringify({ aliases: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(mockProjectData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(
        <ProjectDetailPage params={Promise.resolve({ id: 'proj_test_123' })} />
      );
    });

    await waitFor(() => {
      expect(screen.getByText('Nexus Gateway Alpha')).toBeInTheDocument();
    });

    return renderResult!;
  };

  describe('F-03: ARIA Tab Semantics and Keyboard Navigation in Project Detail', () => {

    it('renders tablist container with semantic role and accessible label', async () => {
      await setupProjectDetail();

      const tablist = screen.getByRole('tablist', { name: /Project Management Tabs/i });
      expect(tablist).toBeInTheDocument();
    });

    it('renders all tabs with role="tab", aria-selected, and aria-controls attributes', async () => {
      await setupProjectDetail();

      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(4);

      const [configTab, keysTab, aliasesTab, credentialsTab] = tabs;

      // Config Tab (default active)
      expect(configTab).toHaveAttribute('id', 'tab-config');
      expect(configTab).toHaveAttribute('aria-selected', 'true');
      expect(configTab).toHaveAttribute('aria-controls', 'tabpanel-config');
      expect(configTab).toHaveAttribute('tabIndex', '0');

      // Other tabs (inactive)
      expect(keysTab).toHaveAttribute('id', 'tab-keys');
      expect(keysTab).toHaveAttribute('aria-selected', 'false');
      expect(keysTab).toHaveAttribute('aria-controls', 'tabpanel-keys');
      expect(keysTab).toHaveAttribute('tabIndex', '-1');

      expect(aliasesTab).toHaveAttribute('id', 'tab-aliases');
      expect(aliasesTab).toHaveAttribute('aria-selected', 'false');
      expect(aliasesTab).toHaveAttribute('aria-controls', 'tabpanel-aliases');
      expect(aliasesTab).toHaveAttribute('tabIndex', '-1');

      expect(credentialsTab).toHaveAttribute('id', 'tab-credentials');
      expect(credentialsTab).toHaveAttribute('aria-selected', 'false');
      expect(credentialsTab).toHaveAttribute('aria-controls', 'tabpanel-credentials');
      expect(credentialsTab).toHaveAttribute('tabIndex', '-1');

      // Initial active tabpanel
      const configPanel = screen.getByRole('tabpanel', { name: /Konfigurasi & Batas/i });
      expect(configPanel).toBeInTheDocument();
      expect(configPanel).toHaveAttribute('id', 'tabpanel-config');
    });

    it('updates active tab and shows corresponding tabpanel on click', async () => {
      await setupProjectDetail();

      const keysTab = screen.getByRole('tab', { name: /API Keys/i });
      await act(async () => {
        fireEvent.click(keysTab);
      });

      expect(keysTab).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: /Konfigurasi & Batas/i })).toHaveAttribute(
        'aria-selected',
        'false'
      );

      const keysPanel = screen.getByRole('tabpanel', { name: /API Keys/i });
      expect(keysPanel).toBeInTheDocument();
      expect(keysPanel).toHaveAttribute('id', 'tabpanel-keys');
    });

    it('supports full keyboard navigation: ArrowRight, ArrowLeft, Home, and End keys', async () => {
      await setupProjectDetail();

      const configTab = screen.getByRole('tab', { name: /Konfigurasi & Batas/i });
      const keysTab = screen.getByRole('tab', { name: /API Keys/i });
      const aliasesTab = screen.getByRole('tab', { name: /Model Aliases/i });
      const credentialsTab = screen.getByRole('tab', { name: /Provider Credentials/i });

      // ArrowRight: config -> keys
      await act(async () => {
        fireEvent.keyDown(configTab, { key: 'ArrowRight' });
      });
      expect(keysTab).toHaveAttribute('aria-selected', 'true');

      // ArrowRight: keys -> aliases
      await act(async () => {
        fireEvent.keyDown(keysTab, { key: 'ArrowRight' });
      });
      expect(aliasesTab).toHaveAttribute('aria-selected', 'true');

      // End: jump to last tab (credentials)
      await act(async () => {
        fireEvent.keyDown(aliasesTab, { key: 'End' });
      });
      expect(credentialsTab).toHaveAttribute('aria-selected', 'true');

      // Home: jump to first tab (config)
      await act(async () => {
        fireEvent.keyDown(credentialsTab, { key: 'Home' });
      });
      expect(configTab).toHaveAttribute('aria-selected', 'true');

      // ArrowLeft with wrap-around: config -> credentials
      await act(async () => {
        fireEvent.keyDown(configTab, { key: 'ArrowLeft' });
      });
      expect(credentialsTab).toHaveAttribute('aria-selected', 'true');
    });
  });

  describe('F-04: Functional Technical Icons (Zero Sparkles Icon)', () => {
    it('verifies that Sparkles icon is completely absent and replaced with functional Link2 in ConnectAntigravityModal', () => {
      const handleClose = vi.fn();
      const handleSuccess = vi.fn();

      const { container } = render(
        <ConnectAntigravityModal
          isOpen={true}
          projectId="proj_test_123"
          onClose={handleClose}
          onSuccess={handleSuccess}
          fetchWithCsrf={mockFetchWithCsrf}
        />
      );

      // Verify the auth flow heading renders Link2 icon container
      const banner = screen.getByText(/Alur Otentikasi Cloud Code \/ Antigravity/i).parentElement;
      expect(banner).toBeInTheDocument();

      // Check svg attributes: lucide-link-2 (or Link2)
      const svg = banner?.querySelector('svg');
      expect(svg).toBeInTheDocument();
      expect(svg?.classList.contains('lucide-sparkles')).toBe(false);
      expect(svg?.classList.contains('lucide-link-2') || svg?.classList.contains('lucide-link2')).toBe(true);

      // Entire modal container should have NO sparkles icon
      const sparklesIcons = container.querySelectorAll('.lucide-sparkles');
      expect(sparklesIcons.length).toBe(0);
    });

    it('verifies that Antigravity connect buttons in ProjectDetailPage use functional technical icon (Link2)', async () => {
      const { container } = await setupProjectDetail();

      // Switch to credentials tab
      const credTab = screen.getByRole('tab', { name: /Provider Credentials/i });
      await act(async () => {
        fireEvent.click(credTab);
      });

      const oauthButtons = screen.getAllByRole('button', {
        name: /Hubungkan Antigravity \(OAuth\)/i,
      });
      expect(oauthButtons.length).toBeGreaterThan(0);

      // Confirm no lucide-sparkles in the entire DOM
      expect(container.querySelectorAll('.lucide-sparkles').length).toBe(0);

      // Confirm lucide-link-2 is present
      const linkIcons = container.querySelectorAll('.lucide-link-2, .lucide-link2');
      expect(linkIcons.length).toBeGreaterThan(0);
    });
  });

  describe('F-05: Tabular Monospaced Numbers on Monitoring Telemetry', () => {
    const mockSummary: MonitoringSummary = {
      totalRequests: 84920,
      successfulRequests: 84500,
      failedRequests: 420,
      averageDurationMs: 142.6,
      totalTokens: {
        promptTokens: 520000,
        completionTokens: 210000,
        totalTokens: 730000,
      },
      projects: [
        {
          projectId: 'p_alpha',
          projectName: 'Alpha Service',
          totalRequests: 50000,
          successfulRequests: 49800,
          failedRequests: 200,
          promptTokens: 300000,
          completionTokens: 120000,
          totalTokens: 420000,
        },
      ],
      providers: [
        {
          provider: 'gemini',
          totalRequests: 84920,
          successfulRequests: 84500,
          failedRequests: 420,
          promptTokens: 520000,
          completionTokens: 210000,
          totalTokens: 730000,
        },
      ],
      preauthRejections: {
        total: 88,
      },
    };

    const mockDetails: MonitoringDetails = {
      total: 1,
      limit: 20,
      offset: 0,
      logs: [
        {
          id: 'log_tab_1',
          requestId: 'req_tabular_test',
          projectId: 'p_alpha',
          projectName: 'Alpha Service',
          model: 'gemini-2.5-flash',
          provider: 'gemini',
          statusCode: 200,
          durationMs: 135,
          result: 'success',
          errorCode: null,
          inputTokens: 250,
          outputTokens: 80,
          totalTokens: 330,
          streaming: false,
          createdAt: '2026-11-06T12:00:00.000Z',
        },
      ],
    };

    it('applies font-mono tabular-nums to KPI metric cards, latency, and tokens', async () => {
      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/summary')) {
          return Promise.resolve(
            new Response(JSON.stringify({ summary: mockSummary }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        }
        if (url.includes('/projects')) {
          return Promise.resolve(
            new Response(JSON.stringify({ projects: [] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        }
        if (url.includes('/details')) {
          return Promise.resolve(
            new Response(JSON.stringify(mockDetails), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        }
        return Promise.reject(new Error('Unknown url'));
      });

      render(<MonitoringPage />);

      await waitFor(() => {
        expect(
          within(screen.getByTestId('metric-total-requests')).getByText('84,920')
        ).toBeInTheDocument();
      });

      // Total requests KPI counter
      const totalReqCounter = within(screen.getByTestId('metric-total-requests')).getByText('84,920');
      expect(totalReqCounter.className).toContain('font-mono');
      expect(totalReqCounter.className).toContain('tabular-nums');

      // Latency counter
      const latencyCounter = within(screen.getByTestId('metric-avg-latency')).getByText(/142\.6 ms/);
      expect(latencyCounter.className).toContain('font-mono');
      expect(latencyCounter.className).toContain('tabular-nums');

      // Token counter
      const tokenCounter = within(screen.getByTestId('metric-total-tokens')).getByText('730,000');
      expect(tokenCounter.className).toContain('font-mono');
      expect(tokenCounter.className).toContain('tabular-nums');

      // Preauth rejections counter
      const preauthCounter = within(screen.getByTestId('metric-preauth-rejections')).getByText('88');
      expect(preauthCounter.className).toContain('font-mono');
      expect(preauthCounter.className).toContain('tabular-nums');
    });

    it('applies font-mono tabular-nums to timestamp, duration, and token cells in request logs table', async () => {
      mockFetchWithCsrf.mockImplementation((url: string) => {
        if (url.includes('/summary')) {
          return Promise.resolve(
            new Response(JSON.stringify({ summary: mockSummary }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        }
        if (url.includes('/projects')) {
          return Promise.resolve(
            new Response(JSON.stringify({ projects: [] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        }
        if (url.includes('/details')) {
          return Promise.resolve(
            new Response(JSON.stringify(mockDetails), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        }
        return Promise.reject(new Error('Unknown url'));
      });

      render(<MonitoringPage />);

      await waitFor(() => {
        expect(screen.getByTestId('log-row-req_tabular_test')).toBeInTheDocument();
      });

      const logRow = screen.getByTestId('log-row-req_tabular_test');

      // First cell: Timestamp
      const timestampCell = logRow.children[0];
      expect(timestampCell.className).toContain('font-mono');
      expect(timestampCell.className).toContain('tabular-nums');

      // 6th cell: Duration
      const durationCell = logRow.children[5];
      expect(durationCell.className).toContain('font-mono');
      expect(durationCell.className).toContain('tabular-nums');

      // 7th cell: Token
      const tokenCell = screen.getByTestId('token-cell');
      const tokenSpans = tokenCell.querySelectorAll('span');
      tokenSpans.forEach((span) => {
        expect(span.className).toContain('font-mono');
        expect(span.className).toContain('tabular-nums');
      });
    });
  });
});
