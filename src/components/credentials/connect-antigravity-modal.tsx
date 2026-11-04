import React, { useState, useEffect, useRef } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertCircle, ExternalLink, CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import { ProviderCredential } from '@/lib/frontend/types';

interface ConnectAntigravityModalProps {
  isOpen: boolean;
  projectId: string;
  onClose: () => void;
  onSuccess: (credential: ProviderCredential) => void;
  fetchWithCsrf: (url: string, init?: RequestInit) => Promise<Response>;
}

export function ConnectAntigravityModal({
  isOpen,
  projectId,
  onClose,
  onSuccess,
  fetchWithCsrf,
}: ConnectAntigravityModalProps) {
  const [displayName, setDisplayName] = useState('Google Antigravity');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // OAuth Flow State
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [codeVerifier, setCodeVerifier] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);

  // Manual fallback input
  const [manualCode, setManualCode] = useState('');
  const [isExchangingManual, setIsExchangingManual] = useState(false);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Clear polling on unmount or close
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const handleStartOAuth = async () => {
    setIsLoading(true);
    setError(null);

    // Open window synchronously on user click to avoid popup blocker
    let authWindow: Window | null = null;
    try {
      authWindow = window.open('about:blank', '_blank');
    } catch {
      // Ignored if browser blocks synchronous open
    }

    try {
      const res = await fetchWithCsrf(`/api/admin/projects/${projectId}/oauth/antigravity/start`, {
        method: 'POST',
        body: JSON.stringify({ displayName: displayName.trim() }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (authWindow && !authWindow.closed) authWindow.close();
        throw new Error(data?.error?.message || 'Gagal memulai sesi OAuth Antigravity');
      }

      setAuthUrl(data.authUrl);
      setState(data.state);
      setCodeVerifier(data.codeVerifier);
      setIsListening(Boolean(data.localListenerRunning));

      // Navigate opened window to authUrl
      if (authWindow && !authWindow.closed) {
        authWindow.location.href = data.authUrl;
      } else {
        // Fallback open if synchronous blank failed
        window.open(data.authUrl, '_blank', 'noopener,noreferrer');
      }

      // Start polling status
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = setInterval(async () => {
        try {
          const statusRes = await fetchWithCsrf(
            `/api/admin/projects/${projectId}/oauth/antigravity/status?state=${encodeURIComponent(data.state)}`
          );
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            if (statusData.status === 'completed' && statusData.credential) {
              if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
              setIsCompleted(true);
              setTimeout(() => {
                onSuccess(statusData.credential);
                handleClose();
              }, 1200);
            } else if (statusData.status === 'error') {
              if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
              setError(statusData.error || 'Autentikasi gagal');
            }
          }
        } catch {
          // Ignore transient polling network errors
        }
      }, 1500);
    } catch (err: unknown) {
      if (authWindow && !authWindow.closed) authWindow.close();
      setError(err instanceof Error ? err.message : 'Terjadi kesalahan sistem');
    } finally {
      setIsLoading(false);
    }
  };

  const handleManualExchange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualCode.trim()) return;

    setIsExchangingManual(true);
    setError(null);

    try {
      const res = await fetchWithCsrf(`/api/admin/projects/${projectId}/oauth/antigravity/exchange`, {
        method: 'POST',
        body: JSON.stringify({
          code: manualCode.trim(),
          state: state || undefined,
          codeVerifier: codeVerifier || undefined,
          displayName: displayName.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error?.message || 'Penukaran kode OAuth gagal');
      }

      if (data?.credential) {
        setIsCompleted(true);
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        setTimeout(() => {
          onSuccess(data.credential);
          handleClose();
        }, 1200);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Gagal menukar kode otentikasi');
    } finally {
      setIsExchangingManual(false);
    }
  };

  const handleClose = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setAuthUrl(null);
    setState(null);
    setCodeVerifier(null);
    setManualCode('');
    setIsCompleted(false);
    setError(null);
    onClose();
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      title="Hubungkan Google Antigravity (OAuth)"
      description="Gunakan akun Google Antigravity resmi dengan alur OAuth PKCE dan auto-refresh token."
      maxWidth="max-w-lg"
    >
      <div className="space-y-4">
        {error && (
          <div role="alert" className="p-3 rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {isCompleted ? (
          <div className="py-6 text-center space-y-2">
            <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto animate-bounce" />
            <h4 className="text-base font-semibold text-foreground">Kredensial Antigravity Berhasil Dihubungkan!</h4>
            <p className="text-xs text-muted-foreground">Kredensial telah disimpan dan dienkripsi dengan AES-256-GCM.</p>
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="antigravity-cred-name" className="block text-xs font-medium text-foreground mb-1">
                Display Name
              </label>
              <input
                id="antigravity-cred-name"
                type="text"
                value={displayName}
                disabled={Boolean(authUrl)}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Google Antigravity Primary"
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {!authUrl ? (
              <div className="p-4 rounded-xl border border-sky-500/30 bg-sky-500/5 space-y-3">
                <div className="flex items-center gap-2 text-sky-400 font-medium text-xs">
                  <Sparkles className="w-4 h-4" />
                  <span>Alur Otentikasi Cloud Code / Antigravity</span>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Menghubungkan akun Google Antigravity memungkinkan gateway mengakses Claude 3.5 Sonnet, Gemini 2.5 Pro, Flash, dan model Antigravity lainnya melalui impersonation Cloud Code dengan auto-refresh token.
                </p>
                <Button
                  onClick={handleStartOAuth}
                  isLoading={isLoading}
                  className="w-full gap-2 bg-sky-600 hover:bg-sky-500 text-white"
                >
                  <ExternalLink className="w-4 h-4" />
                  <span>Buka Halaman Login Google (OAuth)</span>
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="p-4 rounded-xl border border-border bg-muted/50 space-y-3 text-center">
                  <div className="flex items-center justify-center gap-2 text-sky-400 text-xs font-medium">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Menunggu Persetujuan Login di Browser...</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {isListening
                      ? 'Listener lokal aktif di port 51121. Setelah Anda mengizinkan akun di browser, callback akan ditangkap secara otomatis.'
                      : 'Buka tautan login di browser Anda jika belum terbuka:'}
                  </p>
                  <div className="flex flex-col sm:flex-row items-center justify-center gap-2">
                    <a
                      href={authUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Buka Halaman Login Google</span>
                    </a>
                  </div>
                </div>

                <div className="border-t border-border pt-3">
                  <form onSubmit={handleManualExchange} className="space-y-2">
                    <label htmlFor="manual-code-input" className="block text-[11px] font-medium text-foreground">
                      Alternatif: Tempelkan Authorization Code atau URL Callback
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="manual-code-input"
                        type="text"
                        value={manualCode}
                        onChange={(e) => setManualCode(e.target.value)}
                        placeholder="http://localhost:51121/oauth-callback?code=4/0A..."
                        className="flex-1 rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        isLoading={isExchangingManual}
                        disabled={!manualCode.trim()}
                      >
                        Hubungkan
                      </Button>
                    </div>
                  </form>
                </div>
              </div>
            )}

            <div className="flex justify-end pt-2 border-t border-border">
              <Button type="button" variant="outline" onClick={handleClose}>
                Tutup
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
