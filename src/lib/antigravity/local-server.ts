import http from 'http';
import { parse as parseUrl } from 'url';
import { Db } from 'mongodb';
import { ANTIGRAVITY_REDIRECT_PORT } from './constants';
import { oauthSessionStore, completeOAuthFlow } from './oauth';
import { getDatabase } from '@/lib/db/client';

let globalServer: http.Server | null = null;
let serverTimeoutTimer: NodeJS.Timeout | null = null;

const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>Google Antigravity Connected</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #090d16;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      background: #131b2e;
      border: 1px solid #1e293b;
      border-radius: 12px;
      padding: 32px 40px;
      text-align: center;
      max-width: 440px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    }
    .icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 8px 0;
      color: #38bdf8;
    }
    p {
      font-size: 14px;
      color: #94a3b8;
      line-height: 1.5;
      margin: 0 0 20px 0;
    }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 9999px;
      background: #064e3b;
      color: #34d399;
      font-size: 12px;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✨</div>
    <h1>Autentikasi Antigravity Berhasil!</h1>
    <p>Akun Google Antigravity Anda telah berhasil dihubungkan ke Antigravity Gateway.</p>
    <div class="badge">Anda dapat menutup tab ini sekarang</div>
  </div>
  <script>
    setTimeout(() => {
      try { window.close(); } catch(e) {}
    }, 2500);
  </script>
</body>
</html>`;

function getErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>Authentication Error</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #090d16;
      color: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .card {
      background: #1e1518;
      border: 1px solid #451a1a;
      border-radius: 12px;
      padding: 32px 40px;
      text-align: center;
      max-width: 440px;
    }
    h1 { color: #f87171; font-size: 20px; margin: 0 0 8px 0; }
    p { font-size: 14px; color: #cbd5e1; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Gagal Mengotentikasi</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

/**
 * Starts the local HTTP listener on port 51121 to automatically catch OAuth callback.
 * Idempotent: If already listening, keeps running.
 */
export async function startLocalOAuthListener(): Promise<{ success: boolean; port: number; message?: string }> {
  if (globalServer && globalServer.listening) {
    resetTimeoutTimer();
    return { success: true, port: ANTIGRAVITY_REDIRECT_PORT };
  }

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const parsed = parseUrl(req.url || '', true);

      if (parsed.pathname !== '/oauth-callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const code = parsed.query.code as string;
      const state = parsed.query.state as string;
      const error = parsed.query.error as string;

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getErrorHtml(`Google OAuth error: ${error}`));
        if (state) {
          const session = oauthSessionStore.get(state);
          if (session) {
            session.status = 'error';
            session.error = error;
          }
        }
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getErrorHtml('Parameter code atau state tidak ditemukan'));
        return;
      }

      const session = oauthSessionStore.get(state);
      if (!session) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(getErrorHtml('Sesi OAuth tidak valid atau sudah kadaluarsa'));
        return;
      }

      try {
        const db = await getDatabase();
        const credDoc = await completeOAuthFlow(db, {
          code,
          codeVerifier: session.codeVerifier,
          projectId: session.projectId,
          displayName: session.displayName,
        });

        session.status = 'completed';
        session.credentialId = credDoc._id?.toString();

        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store',
        });
        res.end(SUCCESS_HTML);

        // Gracefully shut down server after successful auth
        setTimeout(() => {
          stopLocalOAuthListener();
        }, 3000);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Terjadi kesalahan sistem';
        session.status = 'error';
        session.error = errMsg;

        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(getErrorHtml(errMsg));
      }
    });

    server.once('error', (err: NodeJS.ErrnoException) => {
      console.warn(`Local OAuth server warning: port ${ANTIGRAVITY_REDIRECT_PORT} could not be bound (${err.code}). Manual code paste is supported.`);
      resolve({
        success: false,
        port: ANTIGRAVITY_REDIRECT_PORT,
        message: err.message,
      });
    });

    server.listen(ANTIGRAVITY_REDIRECT_PORT, '127.0.0.1', () => {
      globalServer = server;
      resetTimeoutTimer();
      resolve({ success: true, port: ANTIGRAVITY_REDIRECT_PORT });
    });
  });
}

function resetTimeoutTimer() {
  if (serverTimeoutTimer) {
    clearTimeout(serverTimeoutTimer);
  }
  // Auto-close after 10 minutes of inactivity
  serverTimeoutTimer = setTimeout(() => {
    stopLocalOAuthListener();
  }, 10 * 60 * 1000);
}

/**
 * Stops the local HTTP listener.
 */
export function stopLocalOAuthListener(): void {
  if (serverTimeoutTimer) {
    clearTimeout(serverTimeoutTimer);
    serverTimeoutTimer = null;
  }
  if (globalServer) {
    globalServer.close();
    globalServer = null;
  }
}

