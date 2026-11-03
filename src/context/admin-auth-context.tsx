'use client';

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from 'react';
import { AdminUser } from '@/lib/frontend/types';

interface AuthContextValue {
  admin: AdminUser | null;
  csrfToken: string | null;
  isLoading: boolean;
  lockoutSeconds: number;
  login: (email: string, password: string) => Promise<{ success: boolean; error?: string; retryAfter?: number }>;
  logout: () => Promise<void>;
  refreshCsrf: () => Promise<string | null>;
  fetchWithCsrf: (url: string, init?: RequestInit) => Promise<Response>;
}

const AdminAuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  // In-memory state only - ZERO storage in localStorage / sessionStorage
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [lockoutSeconds, setLockoutSeconds] = useState(0);

  // Countdown timer for 429 rate limit lockout
  useEffect(() => {
    if (lockoutSeconds <= 0) return;
    const interval = setInterval(() => {
      setLockoutSeconds((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [lockoutSeconds]);

  /**
   * Refreshes CSRF token transparently via GET /api/admin/csrf
   * Does not require re-authentication if the session cookie is valid.
   */
  const refreshCsrf = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch('/api/admin/csrf', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) {
        return null;
      }
      const data = await res.json();
      if (data?.csrfToken && typeof data.csrfToken === 'string') {
        setCsrfToken(data.csrfToken);
        return data.csrfToken;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  /**
   * Authenticated fetch wrapper that automatically injects in-memory CSRF token
   * for mutation requests and handles 401/403 session expiration.
   */
  const fetchWithCsrf = useCallback(
    async (url: string, init: RequestInit = {}): Promise<Response> => {
      const method = (init.method || 'GET').toUpperCase();
      const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

      let token = csrfToken;
      if (isMutation && !token) {
        token = await refreshCsrf();
      }

      const headers = new Headers(init.headers || {});
      if (isMutation && token) {
        headers.set('X-CSRF-Token', token);
      }
      if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
        headers.set('Content-Type', 'application/json');
      }

      const response = await fetch(url, {
        ...init,
        headers,
        credentials: 'include',
      });

      if (response.status === 401 || response.status === 403) {
        // If session expired or invalid, reset memory state
        setAdmin(null);
        setCsrfToken(null);
      }

      return response;
    },
    [csrfToken, refreshCsrf]
  );

  /**
   * Initial session bootstrap on mount / page reload (F5)
   */
  useEffect(() => {
    let isMounted = true;
    async function initSession() {
      setIsLoading(true);
      try {
        const token = await refreshCsrf();
        if (token && isMounted) {
          // Check current authenticated admin
          const meRes = await fetch('/api/admin/me', {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            credentials: 'include',
            cache: 'no-store',
          });
          if (meRes.ok) {
            const meData = await meRes.json();
            if (meData?.admin && isMounted) {
              setAdmin(meData.admin);
            }
          }
        }
      } catch {
        // Unauthenticated or network error
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    initSession();
    return () => {
      isMounted = false;
    };
  }, [refreshCsrf]);

  /**
   * Login handler
   */
  const login = useCallback(
    async (email: string, password: string) => {
      let currentCsrf = csrfToken;
      if (!currentCsrf) {
        currentCsrf = await refreshCsrf();
      }

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        };
        if (currentCsrf) {
          headers['X-CSRF-Token'] = currentCsrf;
        }

        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers,
          credentials: 'include',
          body: JSON.stringify({ email, password }),
        });

        if (res.status === 429) {
          const retryHeader = res.headers.get('Retry-After');
          const seconds = retryHeader ? parseInt(retryHeader, 10) || 60 : 60;
          setLockoutSeconds(seconds);
          return {
            success: false,
            error: `Terlalu banyak percobaan gagal. Akses ditangguhkan selama ${seconds} detik.`,
            retryAfter: seconds,
          };
        }

        const data = await res.json().catch(() => null);

        if (!res.ok) {
          const message = data?.error?.message || 'Email atau kata sandi tidak sesuai';
          return {
            success: false,
            error: message,
          };
        }

        if (data?.csrfToken) {
          setCsrfToken(data.csrfToken);
        }
        if (data?.admin) {
          setAdmin(data.admin);
        }

        return { success: true };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Gagal terhubung ke server autentikasi';
        return {
          success: false,
          error: message,
        };
      }
    },
    [csrfToken, refreshCsrf]
  );

  /**
   * Logout handler
   */
  const logout = useCallback(async () => {
    try {
      if (csrfToken) {
        await fetch('/api/admin/logout', {
          method: 'POST',
          headers: {
            'X-CSRF-Token': csrfToken,
          },
          credentials: 'include',
        });
      }
    } catch {
      // Proceed to clear state regardless of network response
    } finally {
      setAdmin(null);
      setCsrfToken(null);
    }
  }, [csrfToken]);

  const value: AuthContextValue = {
    admin,
    csrfToken,
    isLoading,
    lockoutSeconds,
    login,
    logout,
    refreshCsrf,
    fetchWithCsrf,
  };

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  const context = useContext(AdminAuthContext);
  if (!context) {
    throw new Error('useAdminAuth must be used within an AdminAuthProvider');
  }
  return context;
}
