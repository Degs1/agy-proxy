'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AdminAuthProvider, useAdminAuth } from '@/context/admin-auth-context';
import { Button } from '@/components/ui/button';
import { Shield, Eye, EyeOff, AlertCircle, Clock, CheckCircle2 } from 'lucide-react';

function LoginForm() {
  const router = useRouter();
  const { admin, login, lockoutSeconds, isLoading } = useAdminAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // If already authenticated, redirect
  useEffect(() => {
    if (!isLoading && admin) {
      router.push('/admin/projects');
    }
  }, [admin, isLoading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lockoutSeconds > 0) return;

    setErrorMsg(null);
    setSubmitting(true);

    try {
      const res = await login(email.trim(), password);
      if (res.success) {
        router.push('/admin/projects');
      } else {
        setErrorMsg(res.error || 'Autentikasi gagal');
        setPassword(''); // Reset password field on failure
      }
    } finally {
      setSubmitting(false);
    }
  };

  const isLocked = lockoutSeconds > 0;

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 sm:p-8 shadow-2xl text-card-foreground">
        {/* Brand header */}
        <div className="flex flex-col items-center text-center mb-6">
          <div className="w-12 h-12 rounded-xl bg-primary flex items-center justify-center text-primary-foreground mb-3 shadow-lg shadow-primary/20">
            <Shield className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold tracking-tight text-foreground">Portal Administrasi</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Masuk untuk mengelola gateway AI privat, kredensial, dan API key.
          </p>
        </div>

        {/* Error / Lockout Alerts */}
        {isLocked ? (
          <div
            role="alert"
            className="mb-5 rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-3.5 text-xs text-yellow-500 flex items-start gap-2.5 animate-in fade-in"
          >
            <Clock className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Batas Percobaan Tercapai (Rate Limited)</p>
              <p className="mt-0.5 leading-relaxed">
                Terlalu banyak percobaan gagal. Akses ditangguhkan selama{' '}
                <span className="font-mono font-bold text-yellow-400">{lockoutSeconds}</span> detik.
              </p>
            </div>
          </div>
        ) : errorMsg ? (
          <div
            role="alert"
            className="mb-5 rounded-lg border border-red-500/40 bg-red-500/10 p-3.5 text-xs text-red-400 flex items-start gap-2.5 animate-in fade-in"
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium">{errorMsg}</p>
            </div>
          </div>
        ) : null}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-email" className="block text-xs font-medium text-foreground mb-1.5">
              Email Administrator
            </label>
            <input
              id="login-email"
              type="email"
              required
              autoFocus
              disabled={isLocked || submitting}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@internal.net"
              className="w-full rounded-lg border border-border bg-muted px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 min-h-[44px]"
            />
          </div>

          <div>
            <label htmlFor="login-password" className="block text-xs font-medium text-foreground mb-1.5">
              Kata Sandi
            </label>
            <div className="relative flex items-center">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                required
                disabled={isLocked || submitting}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                className="w-full rounded-lg border border-border bg-muted px-3 py-2.5 pr-11 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 min-h-[44px]"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                disabled={isLocked || submitting}
                aria-label={showPassword ? 'Sembunyikan sandi' : 'Tampilkan sandi'}
                className="absolute right-1 text-muted-foreground hover:text-foreground p-2 rounded-md transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center cursor-pointer"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <Button
            type="submit"
            className="w-full mt-2 font-medium min-h-[44px]"
            isLoading={submitting}
            disabled={isLocked || submitting}
          >
            {isLocked
              ? `Terkunci (${lockoutSeconds}s)`
              : submitting
              ? 'Memverifikasi Kredensial...'
              : 'Masuk ke Dashboard'}
          </Button>
        </form>

        <div className="mt-6 pt-4 border-t border-border flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          <span>Dilindungi enkripsi sesi & brute-force guard</span>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <AdminAuthProvider>
      <LoginForm />
    </AdminAuthProvider>
  );
}
