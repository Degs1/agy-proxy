// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, renderHook } from '@testing-library/react';
import { AdminAuthProvider, useAdminAuth } from '@/context/admin-auth-context';

describe('Admin Auth & In-Memory CSRF Provider (TASK-069)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('initializes session by calling /api/admin/csrf and /api/admin/me without storing tokens in localStorage or sessionStorage', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/admin/csrf') {
        return Promise.resolve(
          new Response(JSON.stringify({ csrfToken: 'csrf_init_12345' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      if (url === '/api/admin/me') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              admin: { id: 'admin_1', email: 'admin@test.local', role: 'admin' },
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        );
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    global.fetch = mockFetch;

    const { result } = renderHook(() => useAdminAuth(), {
      wrapper: ({ children }) => <AdminAuthProvider>{children}</AdminAuthProvider>,
    });

    // Wait for async initSession to finish
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.csrfToken).toBe('csrf_init_12345');
    expect(result.current.admin).toEqual({
      id: 'admin_1',
      email: 'admin@test.local',
      role: 'admin',
    });

    // CRITICAL SECURITY ASSERTION: Zero tokens in web storage
    expect(localStorage.getItem('csrfToken')).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
    expect(sessionStorage.getItem('csrfToken')).toBeNull();
    expect(sessionStorage.getItem('token')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('handles login flow: sends pre-CSRF and password, sets memory session on success', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/admin/csrf') {
        return Promise.resolve(
          new Response(JSON.stringify({ csrfToken: 'pre_login_csrf_abc' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      if (url === '/api/admin/me') {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      if (url === '/api/admin/login') {
        const body = JSON.parse(init?.body as string);
        expect(body.email).toBe('admin@test.local');
        expect(body.password).toBe('CorrectPassword123!');
        const headers = init?.headers as Record<string, string>;
        expect(headers['X-CSRF-Token']).toBe('pre_login_csrf_abc');

        return Promise.resolve(
          new Response(
            JSON.stringify({
              admin: { id: 'admin_1', email: 'admin@test.local', role: 'admin' },
              csrfToken: 'post_login_csrf_xyz',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        );
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    global.fetch = mockFetch;

    const { result } = renderHook(() => useAdminAuth(), {
      wrapper: ({ children }) => <AdminAuthProvider>{children}</AdminAuthProvider>,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    let loginRes: { success: boolean; error?: string; retryAfter?: number } | undefined;
    await act(async () => {
      loginRes = await result.current.login('admin@test.local', 'CorrectPassword123!');
    });

    expect(loginRes?.success).toBe(true);
    expect(result.current.csrfToken).toBe('post_login_csrf_xyz');
    expect(result.current.admin?.email).toBe('admin@test.local');

    // Verify storage remains empty
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('handles invalid credentials (401) with inline error feedback', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/admin/csrf') {
        return Promise.resolve(
          new Response(JSON.stringify({ csrfToken: 'pre_csrf' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      if (url === '/api/admin/me') {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      if (url === '/api/admin/login') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'invalid_credentials', message: 'Email atau kata sandi tidak sesuai' },
            }),
            {
              status: 401,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        );
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    global.fetch = mockFetch;

    const { result } = renderHook(() => useAdminAuth(), {
      wrapper: ({ children }) => <AdminAuthProvider>{children}</AdminAuthProvider>,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    let loginRes: { success: boolean; error?: string; retryAfter?: number } | undefined;
    await act(async () => {
      loginRes = await result.current.login('wrong@test.local', 'BadPassword');
    });

    expect(loginRes?.success).toBe(false);
    expect(loginRes?.error).toBe('Email atau kata sandi tidak sesuai');
    expect(result.current.admin).toBeNull();
  });

  it('handles login rate limiting (429) by extracting Retry-After header and setting lockout timer', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/admin/csrf') {
        return Promise.resolve(
          new Response(JSON.stringify({ csrfToken: 'pre_csrf' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      if (url === '/api/admin/me') {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      if (url === '/api/admin/login') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: 'rate_limited', message: 'Too many failed login attempts' },
            }),
            {
              status: 429,
              headers: {
                'Content-Type': 'application/json',
                'Retry-After': '45',
              },
            }
          )
        );
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    global.fetch = mockFetch;

    const { result } = renderHook(() => useAdminAuth(), {
      wrapper: ({ children }) => <AdminAuthProvider>{children}</AdminAuthProvider>,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    let loginRes: { success: boolean; error?: string; retryAfter?: number } | undefined;
    await act(async () => {
      loginRes = await result.current.login('locked@test.local', 'BadPassword');
    });

    expect(loginRes?.success).toBe(false);
    expect(loginRes?.retryAfter).toBe(45);
    expect(result.current.lockoutSeconds).toBe(45);
    expect(loginRes?.error).toContain('45 detik');
  });

  it('fetchWithCsrf automatically attaches X-CSRF-Token on mutation requests', async () => {
    let capturedCsrf: string | null = null;
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/admin/csrf') {
        return Promise.resolve(
          new Response(JSON.stringify({ csrfToken: 'valid_csrf_token_999' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      if (url === '/api/admin/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ admin: { id: 'admin_1', email: 'admin@test.local', role: 'admin' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      if (url === '/api/admin/projects' && init?.method === 'POST') {
        const headers = init.headers as Headers;
        capturedCsrf = headers.get('X-CSRF-Token');
        return Promise.resolve(
          new Response(JSON.stringify({ project: { id: 'p1', name: 'New Project' } }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    global.fetch = mockFetch;

    const { result } = renderHook(() => useAdminAuth(), {
      wrapper: ({ children }) => <AdminAuthProvider>{children}</AdminAuthProvider>,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    await act(async () => {
      await result.current.fetchWithCsrf('/api/admin/projects', {
        method: 'POST',
        body: JSON.stringify({ name: 'New Project' }),
      });
    });

    expect(capturedCsrf).toBe('valid_csrf_token_999');
  });

  it('clears memory state on logout', async () => {
    let logoutCalled = false;
    const mockFetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/admin/csrf') {
        return Promise.resolve(
          new Response(JSON.stringify({ csrfToken: 'session_csrf' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      if (url === '/api/admin/me') {
        return Promise.resolve(
          new Response(JSON.stringify({ admin: { id: 'admin_1', email: 'admin@test.local', role: 'admin' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      if (url === '/api/admin/logout' && init?.method === 'POST') {
        logoutCalled = true;
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected url: ${url}`));
    });

    global.fetch = mockFetch;

    const { result } = renderHook(() => useAdminAuth(), {
      wrapper: ({ children }) => <AdminAuthProvider>{children}</AdminAuthProvider>,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(result.current.admin).not.toBeNull();

    await act(async () => {
      await result.current.logout();
    });

    expect(logoutCalled).toBe(true);
    expect(result.current.admin).toBeNull();
    expect(result.current.csrfToken).toBeNull();
  });
});
