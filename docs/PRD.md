# PRODUCT REQUIREMENTS DOCUMENT (PRD)
# Antigravity Gateway — Private Multi-Account AI API Gateway

**Version:** 1.0  
**Status:** Ready for Implementation  
**Priority:** High  
**Application Type:** Private AI Gateway / API Proxy  
**Architecture:** Next.js Monolith + Serverless Functions  
**Deployment:** Vercel  
**Database:** MongoDB Atlas  
**Primary Language:** TypeScript  
**Target:** Production-quality MVP

---

# 1. PROJECT OVERVIEW

## 1.1 Product Summary

Antigravity Gateway adalah aplikasi web private yang berfungsi sebagai centralized AI API gateway.

Aplikasi memungkinkan administrator mengelola beberapa akun AI provider, mengatur akses API untuk banyak project, memonitor penggunaan, dan menyediakan endpoint kompatibel dengan OpenAI API.

Tujuan utamanya adalah membuat alternatif ringan dari 9Router yang:

- Berjalan menggunakan Next.js.
- Dapat di-deploy ke Vercel.
- Menggunakan MongoDB Atlas.
- Tidak membutuhkan service proxy terpisah.
- Mendukung banyak akun provider.
- Memiliki sistem autentikasi dan manajemen credential.
- Mendukung banyak project dan API key.
- Memiliki rate limiting terdistribusi.
- Mendukung streaming AI response.
- Mendukung OAuth token refresh untuk provider yang mengizinkannya.
- Memiliki dashboard monitoring.
- Memiliki provider adapter yang modular.

**Primary target provider:** Google Antigravity.

**Implementation constraint:** Antigravity OAuth dan inference tidak boleh diasumsikan sebagai API publik. Agent wajib memverifikasi dokumentasi, protokol, izin akses, dan kompatibilitas sebelum mengimplementasikan adapter yang benar-benar mengirim request.

Jika integrasi Antigravity tidak dapat diverifikasi, agent tetap wajib menyelesaikan seluruh gateway menggunakan provider resmi seperti Gemini API, sambil menyediakan Antigravity adapter dengan status `unsupported` atau `pending_verification`.

Jangan menggunakan endpoint, OAuth client ID, scope, atau credential internal yang tidak terverifikasi.

## 1.2 Problem Statement

Developer yang memiliki beberapa aplikasi berbasis AI sering menghadapi masalah:

1. Setiap project harus mengelola konfigurasi AI provider sendiri.
2. Credential tersebar di berbagai repository.
3. Sulit memonitor penggunaan AI antarproject.
4. Tidak tersedia pengaturan RPM dan concurrency terpusat.
5. Pengelolaan beberapa akun provider menjadi rumit.
6. Integrasi API dan streaming berbeda antarprovider.
7. Menjalankan router tambahan membutuhkan infrastruktur ekstra.

Antigravity Gateway menyelesaikan masalah ini dengan satu endpoint API terpusat.

## 1.3 Product Goals

### Primary Goals

- Membuat private AI gateway yang dapat digunakan banyak project.
- Menyediakan OpenAI-compatible API.
- Mengelola credential provider secara aman.
- Mendukung multi-account dengan isolasi dan kebijakan penggunaan yang benar.
- Mengimplementasikan rate limiting yang aman pada serverless architecture.
- Menyediakan streaming response dengan SSE.
- Mendukung deployment ke Vercel.
- Menggunakan MongoDB sebagai persistent storage.

### Secondary Goals

- Dashboard modern dan responsif.
- Statistik request dan error.
- Monitoring account health.
- Per-project usage tracking.
- Token lifecycle management.
- API key rotation.
- Provider extensibility.

## 1.4 Non-Goals

MVP tidak membutuhkan:

- Public registration.
- Payment gateway.
- Subscription billing.
- Public API marketplace.
- Multi-tenant SaaS billing.
- Kubernetes.
- Dedicated queue worker.
- External proxy server.
- Multi-region deployment.
- Automated bypass of provider quotas.
- CAPTCHA bypass atau anti-abuse evasion.

---

# 2. USER ROLES

## 2.1 Administrator

Hanya administrator yang dapat mengakses dashboard.

Administrator dapat:

- Login ke dashboard.
- Mengelola akun provider.
- Menghubungkan OAuth account jika didukung.
- Menambahkan credential API resmi.
- Menghapus dan menonaktifkan akun.
- Membuat project.
- Membuat dan mencabut API key.
- Mengatur RPM dan concurrency.
- Melihat penggunaan dan request logs.
- Mengatur model allowlist.
- Melihat status kesehatan gateway.
- Menjalankan pengujian provider.

## 2.2 API Consumer

API consumer adalah aplikasi eksternal yang memiliki API key.

API consumer dapat:

- Mengakses endpoint AI.
- Mengambil daftar model yang diizinkan.
- Menggunakan streaming.
- Menerima respons error standar.
- Mengakses hanya resource sesuai project dan credential yang diberikan.

API consumer tidak memiliki akses dashboard.

---

# 3. TECHNOLOGY STACK

## 3.1 Core Stack

| Layer | Technology |
|---|---|
| Framework | Next.js App Router |
| Language | TypeScript |
| Runtime | Node.js |
| Styling | Tailwind CSS |
| UI Components | shadcn/ui |
| Icons | Lucide React |
| Database | MongoDB Atlas |
| Database Driver | MongoDB Native Driver |
| Validation | Zod |
| Admin Authentication | Auth.js |
| API Compatibility | OpenAI-compatible REST |
| Streaming | Server-Sent Events |
| Encryption | Node.js Crypto |
| Deployment | Vercel |
| Cron | Vercel Cron |
| Charts | Recharts |
| Testing | Vitest + Playwright |

## 3.2 Architectural Constraints

- Gunakan Next.js sebagai satu-satunya aplikasi utama.
- Jangan membuat Express server terpisah.
- Jangan mengandalkan in-memory global state untuk rate limiting.
- Jangan mengandalkan background worker yang selalu hidup.
- Jangan menyimpan credential di browser.
- Semua secret harus berada di server environment.
- Semua API routes harus menggunakan Node.js runtime.
- Gunakan MongoDB atomic operations untuk shared state.
- Streaming harus kompatibel dengan batas durasi Vercel.
- Hindari dependency yang membutuhkan persistent local filesystem.

---

# 4. SYSTEM ARCHITECTURE

## 4.1 High-Level Flow

```text
External Projects
       |
       | OpenAI-compatible API
       v
Next.js API Gateway
       |
       v
API Key Authentication
       |
       v
Project Authorization
       |
       v
Global + Project Rate Limiter
       |
       v
Model Resolver
       |
       v
Authorized Account Selector
       |
       v
Account Concurrency Reservation
       |
       v
Credential / Token Manager
       |
       v
Provider Adapter
       |
       v
Upstream AI Provider
       |
       v
Response Transformer
       |
       v
Streaming / JSON Response
       |
       v
External Project
```

## 4.2 Internal Modules

### Authentication Module

Bertanggung jawab untuk:

- Admin session.
- API key validation.
- Project authorization.
- Role verification.

### Provider Module

Bertanggung jawab untuk:

- Credential management.
- OAuth integration.
- Token refresh.
- Request transformation.
- Response normalization.
- Provider errors.

### Scheduler Module

Bertanggung jawab untuk:

- Memilih akun yang berwenang.
- Memeriksa account health.
- Memeriksa kapasitas.
- Mengelola cooldown.
- Melakukan concurrency reservation.

### Rate Limiter Module

Bertanggung jawab untuk:

- Global request limits.
- Project RPM.
- Project concurrency.
- Account concurrency.
- Retry-After calculation.

### Monitoring Module

Bertanggung jawab untuk:

- Request logs.
- Usage statistics.
- Latency.
- Error rate.
- Provider status.

---

# 5. FUNCTIONAL REQUIREMENTS

## FR-001 — Private Admin Authentication

**Priority: P0**

Sistem harus memiliki autentikasi admin.

Requirements:

- Tidak tersedia public signup.
- Admin dibuat melalui environment configuration atau protected bootstrap script.
- Login menggunakan Auth.js.
- Dashboard hanya dapat diakses admin.
- Semua admin API routes harus melakukan session verification.
- Session menggunakan secure HTTP-only cookies.
- Login memiliki brute-force protection.
- Logout mengakhiri session.
- Admin mutation endpoints harus memiliki perlindungan CSRF/origin sesuai metode autentikasi.

Acceptance Criteria:

- User tanpa session tidak dapat membuka dashboard.
- User tanpa session tidak dapat memanggil admin API.
- API key project tidak dapat digunakan sebagai admin credential.
- Session invalid ditolak.

## FR-002 — Provider Account Management

**Priority: P0**

Administrator dapat mengelola banyak akun provider.

Account attributes:

- Account ID.
- Display name.
- Provider.
- Provider account identifier.
- Credential type.
- Encrypted credentials.
- Token expiration.
- Account status.
- Last successful request.
- Last error.
- Cooldown expiration.
- Allowed models.
- Account usage policy.

Supported statuses:

- `active`
- `disabled`
- `cooldown`
- `reauth_required`
- `unsupported`
- `error`

Actions:

- Add account.
- Connect supported OAuth account.
- Add official API credential.
- Test connection.
- Disable account.
- Re-enable account.
- Delete account.
- Inspect account health.

Requirements:

- Credential tidak pernah ditampilkan kembali setelah disimpan.
- Akun hanya dapat digunakan untuk request yang memang diizinkan.
- Akun yang membutuhkan reauthentication tidak dipilih.
- Account selection harus mempertimbangkan provider dan model.
- Account status harus persisten di MongoDB.

## FR-003 — OAuth Integration

**Priority: P0 for supported OAuth providers; conditional for Antigravity**

OAuth harus mengikuti authorization-code flow dengan PKCE jika provider mendukungnya.

Flow:

1. Admin memilih Connect Account.
2. Server membuat `state`, `code_verifier`, dan `code_challenge`.
3. Browser diarahkan ke authorization endpoint resmi.
4. Admin memberikan consent.
5. Provider mengembalikan authorization code.
6. Server memvalidasi state.
7. Server menukar code menjadi token.
8. Credential disimpan terenkripsi.
9. Account ditandai active setelah validasi berhasil.

Security Requirements:

- Gunakan PKCE S256 jika didukung.
- Validasi state.
- Batasi masa berlaku OAuth transaction.
- Jangan menyimpan token di URL.
- Jangan log access token atau refresh token.
- Gunakan exact redirect URI.
- Gunakan OAuth scope minimum.
- OAuth client harus terdaftar dan diizinkan untuk aplikasi ini.

### Antigravity-Specific Requirement

Agent harus memeriksa apakah tersedia:

- OAuth authorization endpoint yang didukung.
- OAuth client registration yang sah.
- Scope yang mengizinkan AI inference.
- Dokumentasi inference API.
- Model identifiers.
- Streaming protocol.
- Token refresh behavior.
- Ketentuan penggunaan integrasi pihak ketiga.

Jika tidak tersedia, jangan mengarang implementasi.

Tampilkan status integrasi Antigravity sebagai `Pending Verification`.

## FR-004 — Token Lifecycle Management

**Priority: P0 for OAuth providers**

Token manager harus mendukung:

- Token expiry detection.
- Lazy refresh.
- Scheduled refresh.
- Refresh failure handling.
- Reauthentication requirement.
- Distributed refresh locking.

Refresh behavior:

- Jika token masih valid, gunakan token saat ini.
- Jika hampir expired, lakukan refresh sebelum request.
- Jika refresh sedang dilakukan instance lain, jangan melakukan refresh kedua secara paralel.
- Jika refresh berhasil, simpan token baru secara atomik.
- Jika refresh token dirotasi, simpan token pengganti.
- Jika provider mengembalikan invalid_grant, ubah status menjadi `reauth_required`.

Gunakan MongoDB lease dengan expiration dan fencing/version check.

Cron hanya berfungsi sebagai preventive refresh.

Lazy refresh tetap wajib karena cron dapat terlambat atau tidak berjalan.

## FR-005 — Multi-Project Management

**Priority: P0**

Administrator dapat membuat banyak project.

Project fields:

- Project ID.
- Name.
- Description.
- Status.
- RPM limit.
- Concurrent request limit.
- Allowed models.
- Allowed provider accounts.
- Created timestamp.
- Updated timestamp.

Actions:

- Create project.
- Update project.
- Disable project.
- Delete project.
- Configure limits.
- Configure allowed models.
- Configure account authorization.

Requirements:

- Setiap project memiliki batas penggunaan independen.
- Project tidak dapat menggunakan akun di luar allowlist.
- Disabled project tidak dapat mengakses API.
- Penghapusan project harus mencabut API key terkait.

## FR-006 — API Key Management

**Priority: P0**

Setiap project dapat memiliki beberapa API key.

API key format:

`agw_<cryptographically-random-secret>`

Requirements:

- Gunakan CSPRNG.
- Minimal 256-bit random secret.
- Simpan hash API key.
- Tampilkan plaintext hanya sekali.
- Support revoke.
- Support expiration.
- Support optional key rotation.
- Support key description.
- Support last-used timestamp.
- Support per-key model restrictions jika dibutuhkan.

API key harus dikirim menggunakan:

`Authorization: Bearer <API_KEY>`

Jika API key invalid, kembalikan HTTP 401.

Jika project disabled, kembalikan HTTP 403.

## FR-007 — OpenAI-Compatible API

**Priority: P0**

Implementasikan endpoint:

`POST /api/v1/chat/completions`

Request format:

```json
{
  "model": "gemini-2.5-flash",
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ],
  "temperature": 0.7,
  "max_tokens": 1024,
  "stream": false
}
```

Required request fields:

- `model`
- `messages`

Optional fields:

- `temperature`
- `top_p`
- `max_tokens`
- `stream`
- `stop`

Implementasikan parameter opsional hanya jika adapter provider mendukungnya.

Jika parameter tidak didukung, kembalikan validation error yang jelas, bukan mengabaikannya diam-diam.

Response harus mengikuti format OpenAI Chat Completions.

Example:

```json
{
  "id": "chatcmpl_example",
  "object": "chat.completion",
  "created": 1760000000,
  "model": "gemini-2.5-flash",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello!"
      },
      "finish_reason": "stop"
    }
  ]
}
```

Usage metadata harus menggunakan nilai yang benar-benar dilaporkan provider.

Jika usage tidak tersedia, jangan mengarang jumlah token.

## FR-008 — Model Discovery

**Priority: P0**

Endpoint:

`GET /api/v1/models`

Requirements:

- Hanya tampilkan model yang dikonfigurasi.
- Filter berdasarkan API key.
- Filter berdasarkan project allowlist.
- Jangan tampilkan model yang tidak didukung.
- Jangan mengklaim model tersedia hanya berdasarkan hardcoded model list.

Response format mengikuti OpenAI model listing.

Model mapping disimpan sebagai konfigurasi.

Contoh:

```json
{
  "publicModelId": "gateway-fast",
  "provider": "gemini",
  "upstreamModelId": "gemini-2.5-flash",
  "enabled": true
}
```

## FR-009 — Streaming SSE

**Priority: P0**

Endpoint chat completions harus mendukung:

`"stream": true`

Requirements:

- Gunakan ReadableStream.
- Gunakan `text/event-stream`.
- Kirim OpenAI-compatible chunks.
- Kirim `data: [DONE]` saat berhasil selesai.
- Support client cancellation.
- Hentikan upstream request ketika client disconnect jika memungkinkan.
- Jangan buffer seluruh response sebelum dikirim.
- Jangan menulis secret ke stream.
- Tangani upstream errors sebelum dan sesudah stream dimulai.

Pastikan:

- Streaming berfungsi di Vercel.
- Tidak ada response duplication.
- Resource reservation dilepas setelah completion, cancellation, atau failure.
- Long-running request mengikuti batas runtime deployment.

## FR-010 — Rate Limiting

**Priority: P0**

Implementasikan rate limiting terdistribusi.

### Layer 1: Global Gateway Limit

Melindungi keseluruhan sistem dari overload.

### Layer 2: Per-Project RPM

Setiap project memiliki batas request per menit.

### Layer 3: Per-Project Concurrency

Membatasi jumlah request aktif per project.

### Layer 4: Per-Account Capacity

Membatasi request sesuai kebijakan dan kapasitas provider.

Requirements:

- Gunakan MongoDB atomic operations.
- Jangan gunakan in-memory counter sebagai sumber kebenaran.
- Gunakan fixed window atau sliding window.
- Semua request paralel harus dihitung secara konsisten.
- Counter initialization harus atomic.
- Hindari duplicate-key race.
- Gunakan unique indexes.
- Return HTTP 429 saat limit tercapai.
- Sertakan `Retry-After` jika dapat ditentukan.
- Jangan menggunakan akun lain untuk menghindari provider-enforced quota.

### Concurrency Reservation

Gunakan lease-based reservation.

Setiap reservation memiliki:

- Reservation ID.
- Project ID.
- Account ID.
- Created timestamp.
- Expiration timestamp.
- Status.

Lease harus dapat dibersihkan ketika function terhenti.

Jangan hanya mengandalkan TTL index untuk release secara real-time.

## FR-011 — Account Scheduler

**Priority: P0**

Scheduler bertugas memilih akun yang layak.

Eligibility criteria:

- Provider cocok.
- Model didukung.
- Akun active.
- Project memiliki izin menggunakan akun.
- Token valid atau dapat diperbarui.
- Tidak dalam cooldown.
- Memiliki kapasitas concurrency.
- Tidak melampaui provider quota.

Selection strategy:

- Prefer healthy eligible account.
- Gunakan least-active atau weighted selection.
- Lakukan atomic capacity reservation.
- Jika reservation gagal karena race, evaluasi ulang kandidat.
- Jika tidak ada akun eligible, return error yang jelas.

Multi-account digunakan untuk isolasi, availability, dan kapasitas yang secara eksplisit diizinkan.

Jangan mengimplementasikan account rotation untuk melewati RPM, quota, suspension, atau enforcement provider.

## FR-012 — Retry and Error Handling

**Priority: P0**

Error categories:

- Authentication error.
- Authorization error.
- Invalid request.
- Unsupported model.
- Rate limit exceeded.
- Upstream timeout.
- Upstream unavailable.
- Credential expired.
- Reauthentication required.
- Internal gateway error.

HTTP response mapping:

| Status | Meaning |
|---|---|
| 400 | Invalid request |
| 401 | Invalid API key |
| 403 | Forbidden |
| 404 | Model not found |
| 429 | Rate limited |
| 502 | Upstream error |
| 503 | No eligible provider capacity |
| 504 | Upstream timeout |

Retry policy:

- Retry hanya untuk error transient yang aman.
- Gunakan exponential backoff dengan jitter.
- Hormati `Retry-After`.
- Jangan retry authentication failures terus-menerus.
- Jangan retry request yang mungkin sudah menghasilkan output tanpa memastikan idempotency.
- Jangan melakukan failover lintas akun untuk menghindari quota enforcement.

## FR-013 — Monitoring and Usage Logs

**Priority: P1**

Log setiap request dengan metadata:

- Request ID.
- Project ID.
- API key ID.
- Provider account ID.
- Model.
- Timestamp.
- Latency.
- HTTP status.
- Input tokens jika tersedia.
- Output tokens jika tersedia.
- Streaming flag.
- Error category.

Requirements:

- Jangan menyimpan prompt secara default.
- Jangan menyimpan response AI secara default.
- Jangan menyimpan credential.
- Support pagination.
- Support filter by project.
- Support filter by provider.
- Support filter by date.
- Support retention policy.

Default retention: 30 hari, dapat dikonfigurasi.

---

# 6. DATABASE DESIGN

Gunakan MongoDB Atlas.

## 6.1 Collection: users

```typescript
interface User {
  _id: ObjectId;
  email: string;
  role: "admin";
  status: "active" | "disabled";
  createdAt: Date;
  updatedAt: Date;
}
```

## 6.2 Collection: projects

```typescript
interface Project {
  _id: ObjectId;
  name: string;
  description?: string;
  status: "active" | "disabled";
  rpmLimit: number;
  concurrencyLimit: number;
  allowedModels: string[];
  allowedAccountIds: ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}
```

## 6.3 Collection: api_keys

```typescript
interface ApiKey {
  _id: ObjectId;
  projectId: ObjectId;
  name: string;
  keyPrefix: string;
  keyHash: string;
  status: "active" | "revoked";
  expiresAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
}
```

## 6.4 Collection: accounts

```typescript
interface ProviderAccount {
  _id: ObjectId;
  ownerId: ObjectId;
  provider: string;
  displayName: string;

  credentialType: "oauth" | "api_key";

  encryptedCredentials: {
    ciphertext: string;
    iv: string;
    authTag: string;
    keyVersion: number;
  };

  expiresAt?: Date;

  status:
    | "active"
    | "disabled"
    | "cooldown"
    | "reauth_required"
    | "unsupported"
    | "error";

  allowedModels: string[];

  maxConcurrent: number;
  cooldownUntil?: Date;

  lastUsedAt?: Date;
  lastError?: string;

  createdAt: Date;
  updatedAt: Date;
}
```

## 6.5 Collection: rate_limits

```typescript
interface RateLimit {
  _id: ObjectId;
  scope: "global" | "project" | "account";
  identifier: string;
  windowStart: Date;
  count: number;
  expiresAt: Date;
}
```

## 6.6 Collection: reservations

```typescript
interface Reservation {
  _id: ObjectId;
  requestId: string;
  projectId: ObjectId;
  accountId: ObjectId;
  status: "active" | "released";
  expiresAt: Date;
  createdAt: Date;
}
```

## 6.7 Collection: request_logs

```typescript
interface RequestLog {
  _id: ObjectId;
  requestId: string;
  projectId: ObjectId;
  apiKeyId: ObjectId;
  accountId?: ObjectId;
  provider: string;
  model: string;
  statusCode: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
  streaming: boolean;
  createdAt: Date;
}
```

## 6.8 Collection: model_configs

```typescript
interface ModelConfig {
  _id: ObjectId;
  publicModelId: string;
  provider: string;
  upstreamModelId: string;
  enabled: boolean;
  supportedFeatures: string[];
  createdAt: Date;
  updatedAt: Date;
}
```

## 6.9 Collection: oauth_locks

Digunakan untuk distributed token refresh coordination.

Fields:

- Account ID.
- Lock owner.
- Fencing version.
- Lock expiration.
- Updated timestamp.

## 6.10 Database Indexes

Agent wajib membuat index initialization script.

Required indexes:

- Unique API key hash.
- Unique public model ID.
- Unique rate-limit scope + identifier + window.
- Unique active request reservation ID.
- Account provider + status.
- Project status.
- Request logs timestamp.
- Request logs project + timestamp.
- TTL index untuk expired logs.
- TTL index untuk expired rate-limit documents.

TTL cleanup tidak boleh dianggap langsung terjadi tepat pada expiration timestamp.

---

# 7. PROVIDER ADAPTER ARCHITECTURE

Buat interface provider generik.

```typescript
interface AIProvider {
  id: string;

  validateCredentials(
    account: ProviderAccount
  ): Promise<boolean>;

  listModels(
    account: ProviderAccount
  ): Promise<ProviderModel[]>;

  chat(
    request: NormalizedChatRequest,
    account: ProviderAccount,
    signal?: AbortSignal
  ): Promise<NormalizedChatResponse>;

  streamChat(
    request: NormalizedChatRequest,
    account: ProviderAccount,
    signal?: AbortSignal
  ): Promise<ReadableStream>;

  refreshToken?(
    account: ProviderAccount
  ): Promise<RefreshedCredentials>;
}
```

Provider adapters:

```text
providers/
├── types.ts
├── registry.ts
├── gemini/
│   ├── client.ts
│   ├── models.ts
│   └── transformer.ts
└── antigravity/
    ├── adapter.ts
    ├── capabilities.ts
    └── verification.md
```

### Gemini Adapter

Gunakan Gemini API resmi sebagai reference implementation.

Mendukung:

- API key authentication.
- Chat completion.
- Streaming.
- Model mapping.
- Error handling.

### Antigravity Adapter

Adapter harus dibuat modular.

Sebelum diaktifkan:

1. Periksa sumber dokumentasi yang relevan.
2. Verifikasi OAuth dan hak akses API.
3. Verifikasi inference endpoint.
4. Verifikasi request schema.
5. Verifikasi response schema.
6. Verifikasi streaming.
7. Verifikasi token lifecycle.
8. Dokumentasikan risiko dan keterbatasan.

Jika tidak dapat diverifikasi, jangan membuat fake implementation.

Tampilkan provider sebagai unavailable dengan alasan yang jelas.

---

# 8. API SPECIFICATION

## Public API

### POST /api/v1/chat/completions

Authentication: API key.

Supports:

- Non-streaming completion.
- Streaming completion.
- Model mapping.
- Project limits.
- Usage logging.

### GET /api/v1/models

Authentication: API key.

Returns models available to the project.

## Admin API

### GET /api/admin/overview

Dashboard metrics.

### GET /api/admin/accounts

List provider accounts.

### POST /api/admin/accounts

Create provider account.

### PATCH /api/admin/accounts/:id

Update account.

### DELETE /api/admin/accounts/:id

Delete account.

### POST /api/admin/accounts/:id/test

Test provider connection.

### GET /api/admin/projects

List projects.

### POST /api/admin/projects

Create project.

### PATCH /api/admin/projects/:id

Update project.

### DELETE /api/admin/projects/:id

Delete project.

### POST /api/admin/projects/:id/keys

Generate API key.

### DELETE /api/admin/keys/:id

Revoke API key.

### GET /api/admin/logs

Paginated request logs.

### GET /api/admin/stats

Usage statistics.

## OAuth API

### GET /api/auth/provider/:provider/connect

Start supported OAuth flow.

### GET /api/auth/provider/:provider/callback

Handle OAuth callback.

## Cron API

### GET /api/cron/refresh

Refresh eligible tokens.

Requires `CRON_SECRET`.

---

# 9. DASHBOARD REQUIREMENTS

## 9.1 Design Direction

Gunakan desain modern SaaS dashboard.

Visual direction:

- Minimal.
- Professional.
- Clean typography.
- Responsive.
- Dark mode.
- Light mode.
- Subtle borders.
- Consistent spacing.
- Accessible controls.
- No excessive gradients.

Gunakan shadcn/ui dan Tailwind CSS.

## 9.2 Layout

Desktop:

- Left sidebar.
- Top header.
- Main content area.
- Responsive cards.
- Tables.
- Dialogs.
- Toast notifications.

Mobile:

- Collapsible navigation.
- Responsive cards.
- Scrollable tables.
- Touch-friendly controls.

## 9.3 Dashboard Pages

### Overview

Display:

- Total accounts.
- Active accounts.
- Total projects.
- Requests today.
- Requests this month.
- Error rate.
- Average latency.
- Request trend chart.
- Recent errors.

### Accounts

Display:

- Account name.
- Provider.
- Status.
- Token expiration if applicable.
- Last used.
- Recent error.
- Connection actions.

Support:

- Add account.
- Connect OAuth.
- Test connection.
- Disable.
- Delete.
- Inspect details.

### Projects

Display:

- Project name.
- Status.
- API keys.
- RPM limit.
- Concurrency limit.
- Allowed models.
- Requests today.

Support CRUD.

### API Keys

Display:

- Key name.
- Prefix.
- Project.
- Created date.
- Last used.
- Status.

Support:

- Generate.
- Copy once.
- Revoke.
- Rotate.

### Logs

Display:

- Request ID.
- Project.
- Provider.
- Model.
- Status.
- Latency.
- Timestamp.

Support filters and pagination.

### Settings

Display:

- Gateway configuration.
- Default limits.
- Enabled models.
- Account policies.
- Logging retention.
- Provider status.

---

# 10. SECURITY REQUIREMENTS

Security is mandatory.

## 10.1 Credential Encryption

Use AES-256-GCM.

Requirements:

- Random IV per encryption.
- Authentication tag verification.
- Encryption key stored in environment variables.
- Key versioning.
- No plaintext credential logging.
- No client-side token storage.

## 10.2 API Security

- Validate API keys.
- Validate request bodies using Zod.
- Enforce request size limits.
- Enforce project authorization.
- Enforce model allowlists.
- Rate-limit unauthenticated requests.
- Prevent credential leakage.
- Prevent SSRF by using fixed upstream endpoint allowlists.
- Never accept arbitrary upstream URLs from API consumers.
- Do not expose MongoDB connection details.
- Return sanitized errors.

## 10.3 Admin Security

- Private admin access.
- Secure session cookies.
- Protected admin endpoints.
- Login rate limiting.
- CSRF/origin protection.
- Audit log for sensitive mutations.
- API key revocation.
- Secure OAuth state handling.

## 10.4 Data Privacy

- Do not log prompt content by default.
- Do not log model response content by default.
- Do not log bearer tokens.
- Do not log OAuth credentials.
- Minimize stored personal information.
- Apply log retention policy.

---

# 11. VERCEL DEPLOYMENT

## 11.1 Environment Variables

```env
MONGODB_URI=

AUTH_SECRET=
ADMIN_EMAIL=

TOKEN_ENCRYPTION_KEY=

GEMINI_API_KEY=

CRON_SECRET=

NEXT_PUBLIC_APP_URL=
```

Additional provider OAuth credentials should only be added when officially supported.

## 11.2 Serverless Compatibility

Requirements:

- No persistent local state.
- No always-on worker dependency.
- No long-lived process requirement.
- Shared state stored in MongoDB.
- Runtime duration configurable.
- Streaming compatible with Vercel.
- Database connections reused when possible.
- Cron jobs must be idempotent.

## 11.3 Cron Strategy

Use daily Vercel Cron as the free-tier baseline.

Implement lazy token refresh for actual requests.

If more frequent refresh is required, document plan limitations and supported alternatives.

Do not assume a 15-minute cron schedule is available on every Vercel plan.

## 11.4 Hosting Limitations

Agent must document:

- Function execution duration.
- Streaming duration limitations.
- Bandwidth limits.
- Cron frequency limits.
- MongoDB connection constraints.
- Hobby plan restrictions.
- Commercial-use restrictions where applicable.

Do not silently rely on paid features.

---

# 12. PERFORMANCE REQUIREMENTS

Targets for MVP, excluding upstream model generation time:

- API authentication overhead: target under 100 ms p95 under light load.
- Rate-limit evaluation: target under 100 ms p95 under light load.
- No duplicate capacity reservation.
- No plaintext credential exposure.
- No unbounded request buffering.
- Streaming begins as soon as upstream produces data.
- Client cancellation propagates upstream where supported.

Targets must be measured and reported rather than assumed.

---

# 13. ERROR HANDLING

Use a consistent error structure:

```json
{
  "error": {
    "message": "Rate limit exceeded",
    "type": "rate_limit_error",
    "code": "project_rpm_exceeded"
  }
}
```

Error codes:

- `invalid_api_key`
- `project_disabled`
- `model_not_found`
- `project_rpm_exceeded`
- `project_concurrency_exceeded`
- `account_unavailable`
- `provider_rate_limited`
- `provider_auth_failed`
- `provider_timeout`
- `provider_error`
- `invalid_request`
- `internal_error`

Never expose upstream credentials or sensitive provider responses.

---

# 14. TESTING REQUIREMENTS

## Unit Tests

Test:

- API key generation.
- API key hashing.
- API key verification.
- Encryption/decryption.
- Model mapping.
- Request validation.
- Rate-limit calculation.
- Provider eligibility.
- Error mapping.

## Integration Tests

Test:

- MongoDB connection.
- Project creation.
- API key creation.
- API key revocation.
- Atomic RPM reservation.
- Concurrency reservation.
- Account selection.
- Credential encryption.
- Token refresh locking.
- Request logging.

## Concurrency Tests

Simulate:

- 50 simultaneous requests.
- Multiple requests at the RPM boundary.
- Multiple requests competing for one account slot.
- Refresh token race.
- Serverless function interruption.
- Lease expiration.
- Duplicate reservation attempts.

Expected:

- No rate-limit oversubscription beyond documented algorithm semantics.
- No duplicate refresh commit.
- No permanent capacity lock.
- No credential leakage.

## Streaming Tests

Test:

- Successful SSE.
- Proper chunk format.
- Final `[DONE]`.
- Client cancellation.
- Upstream failure.
- Timeout.
- Resource release.

## E2E Tests

Using Playwright:

- Admin login.
- Create project.
- Generate API key.
- Add provider credential.
- Configure model.
- Call gateway API.
- View request logs.
- Revoke API key.
- Verify revoked key fails.

---

# 15. IMPLEMENTATION PHASES

## Phase 1 — Foundation

Deliverables:

- Next.js setup.
- Tailwind CSS.
- shadcn/ui.
- MongoDB connection.
- Environment validation.
- Database indexes.
- Admin authentication.
- Dashboard shell.

## Phase 2 — Core Management

Deliverables:

- Account CRUD.
- Project CRUD.
- API key management.
- Credential encryption.
- Model configuration.

## Phase 3 — Gateway Engine

Deliverables:

- API authentication.
- Request validation.
- Model resolver.
- Rate limiter.
- Concurrency reservation.
- Account scheduler.
- Error normalization.

## Phase 4 — Provider Integration

Deliverables:

- Gemini reference adapter.
- Chat completion.
- Streaming.
- Provider health checks.
- Account status management.

## Phase 5 — OAuth Infrastructure

Deliverables:

- OAuth PKCE framework.
- Encrypted token storage.
- Lazy refresh.
- Distributed refresh lock.
- Cron refresh.
- Reauthentication handling.
- Antigravity compatibility assessment.

## Phase 6 — Dashboard and Monitoring

Deliverables:

- Overview metrics.
- Account status.
- Project statistics.
- Request logs.
- Usage charts.
- Error monitoring.

## Phase 7 — Hardening and Deployment

Deliverables:

- Unit tests.
- Integration tests.
- Concurrency tests.
- Streaming tests.
- Security review.
- Vercel deployment configuration.
- README.
- Environment example.
- Deployment documentation.

---

# 16. ACCEPTANCE CRITERIA

The MVP is complete when:

- [ ] Admin can log in securely.
- [ ] Admin can manage projects.
- [ ] Admin can generate and revoke API keys.
- [ ] Admin can manage provider accounts.
- [ ] Credentials are encrypted at rest.
- [ ] API consumers cannot access admin endpoints.
- [ ] API key authentication works.
- [ ] Project-level authorization works.
- [ ] RPM limiting works across concurrent requests.
- [ ] Concurrency reservations work correctly.
- [ ] Account scheduler respects authorization and provider limits.
- [ ] Official Gemini API adapter works.
- [ ] OpenAI-compatible non-streaming requests work.
- [ ] OpenAI-compatible streaming requests work.
- [ ] Model listing works.
- [ ] Client cancellation is handled.
- [ ] Request logs are recorded.
- [ ] Dashboard statistics are functional.
- [ ] OAuth framework supports documented provider flows.
- [ ] Token refresh is concurrency-safe.
- [ ] Antigravity compatibility status is documented accurately.
- [ ] Application builds successfully.
- [ ] Automated tests pass.
- [ ] Deployment to Vercel is documented.
- [ ] No fake functionality or mock production responses remain.

---

# 17. DEFINITION OF DONE

A feature is considered complete only when:

1. Backend implementation exists.
2. Frontend implementation exists if applicable.
3. Database integration works.
4. Validation is implemented.
5. Authentication and authorization are enforced.
6. Error handling exists.
7. Tests cover critical behavior.
8. The feature is documented.
9. No hardcoded secrets are present.
10. No placeholder logic is presented as production functionality.

---

# 18. INSTRUCTIONS FOR CODING AGENT

You are acting as a senior full-stack engineer and software architect.

Your task is to implement the complete Antigravity Gateway MVP based on this PRD.

## Mandatory Engineering Rules

1. Use Next.js App Router and TypeScript.
2. Use MongoDB Atlas with the native MongoDB driver.
3. Use Tailwind CSS and shadcn/ui.
4. Use clean modular architecture.
5. Follow secure-by-default practices.
6. Implement real database operations.
7. Implement real API key management.
8. Implement real rate limiting.
9. Implement real concurrency handling.
10. Implement real streaming.
11. Implement a working official AI provider adapter.
12. Implement OAuth only through documented and authorized provider flows.
13. Never invent provider endpoints or OAuth credentials.
14. Never implement quota bypass or anti-abuse evasion.
15. Never expose secrets in frontend code.
16. Never use mock responses in production endpoints.
17. Never silently swallow errors.
18. Add appropriate loading, empty, and error states.
19. Keep the UI responsive and accessible.
20. Keep the implementation compatible with Vercel.

## Implementation Strategy

First inspect the repository.

If it is empty, initialize the project.

If it already contains code, inspect the existing architecture before modifying anything.

Create a task plan and implement features incrementally.

Prioritize the backend foundation, authentication, database, and gateway engine before advanced dashboard polish.

Do not spend the entire implementation effort on UI while leaving backend functionality incomplete.

Do not claim a feature works unless it has been implemented and verified.

## Important Provider Requirement

The product name is Antigravity Gateway, but the gateway must not depend on an undocumented Antigravity integration to function.

Implement the supported provider reference adapter first.

Research Antigravity compatibility separately.

If no authorized inference integration is available, leave the Antigravity adapter disabled and document the reason.

Do not substitute simulated AI responses for actual inference.

## Expected Final Deliverables

Provide:

1. Complete source code.
2. Working Next.js application.
3. MongoDB database models and indexes.
4. Admin dashboard.
5. API key management.
6. Multi-account infrastructure.
7. Rate limiter.
8. Account scheduler.
9. Provider adapter system.
10. OpenAI-compatible API.
11. Streaming implementation.
12. Token lifecycle infrastructure.
13. Cron endpoint.
14. Automated tests.
15. `.env.example`.
16. `vercel.json`.
17. README with setup instructions.
18. Vercel deployment guide.
19. API usage examples.
20. Known limitations and provider compatibility report.

## Final Verification

Before declaring completion:

- Run TypeScript checks.
- Run lint.
- Run automated tests.
- Run production build.
- Verify API response schema.
- Verify streaming.
- Verify authorization boundaries.
- Verify database indexes.
- Verify no secrets are committed.
- Document any functionality that cannot be tested without external credentials.

If an external credential or configuration is missing, clearly state the blocker and continue implementing independent features.

Do not fabricate successful test results.

**Final objective:** Deliver a functional, secure, maintainable private AI gateway that can be deployed to Vercel and used by multiple external projects through OpenAI-compatible API endpoints.

---

**END OF PRD**
