# Antigravity Gateway (`agy-proxy`)

[![Next.js](https://img.shields.io/badge/Next.js-15.1.4-black?logo=next.js)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?logo=typescript)](https://www.typescriptlang.org/)
[![MongoDB Atlas](https://img.shields.io/badge/MongoDB-Atlas_Driver_6.12-green?logo=mongodb)](https://www.mongodb.com/atlas)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-3.4-38B2AC?logo=tailwind-css)](https://tailwindcss.com/)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)

**Antigravity Gateway** (`agy-proxy`) adalah *private, high-performance AI API Gateway & Reverse Proxy* berbasis **Next.js 15 (App Router)**, dioptimalkan untuk *serverless deployment* di **Vercel** dan backend database **MongoDB Atlas**. 

Aplikasi ini menyediakan antarmuka inferensi yang kompatibel dengan **OpenAI API** (`/v1/chat/completions`), sistem manajemen multi-project dengan *granular API keys*, pembatasan kuota terdistribusi (*atomic concurrency & rate limiting*), arsitektur keamanan *Zero-Plaintext-Recall*, serta portal pemantauan dan telemetri bawaan berstandar desain *Anti-Slop*.

---

## Daftar Isi

- [Fitur Utama](#fitur-utama)
- [Arsitektur Sistem](#arsitektur-sistem)
- [Prasyarat](#prasyarat)
- [Panduan Instalasi Cepat](#panduan-instalasi-cepat)
- [Konfigurasi Environment (`.env`)](#konfigurasi-environment-env)
- [Inisialisasi Database & Bootstrap Admin](#inisialisasi-database--bootstrap-admin)
- [Panduan Penggunaan API](#panduan-penggunaan-api)
  - [OpenAI SDK (Python)](#openai-sdk-python)
  - [OpenAI SDK (Node.js / TypeScript)](#openai-sdk-nodejs--typescript)
  - [cURL (Non-Streaming & SSE Streaming)](#curl-non-streaming--sse-streaming)
  - [Healthcheck Endpoint](#healthcheck-endpoint)
- [Admin Portal & Pengelolaan Proyek](#admin-portal--pengelolaan-proyek)
- [Daftar Perintah (NPM Scripts)](#daftar-perintah-npm-scripts)
- [Panduan Deployment (Vercel + MongoDB Atlas)](#panduan-deployment-vercel--mongodb-atlas)
- [Prinsip Keamanan & Anti-Slop](#prinsip-keamanan--anti-slop)

---

## Fitur Utama

- **OpenAI-Compatible Inference Endpoint (`/v1/chat/completions`)**: Mendukung panggilan teks biasa (*non-streaming*) maupun *streaming* Server-Sent Events (SSE) dengan penanganan *error lifecycle* adaptif.
- **Provider Inferensi Aktif (Google Gemini API)**: Terintegrasi penuh dengan model Gemini (misalnya `gemini-2.5-flash`, `gemini-1.5-pro`) sebagai mesin inferensi produksi MVP dengan sistem manajemen kuota akun ganda.
- **Model Aliasing & Routing Cerdas**: Memetakan alias model klien (misalnya `gpt-4o`, `claude-3-5-sonnet`) secara dinamis ke model AI provider yang aktif di tingkat proyek.
- **Atomic Rate Limiter (MongoDB Atlas Native)**: Menghitung pembatasan RPM (*Requests Per Minute*) dan *Concurrency Limit* secara atomik di database tanpa ketergantungan pada Redis eksternal.
- **Multi-Tenant / Multi-Project Access**: Proyek independen dengan pasangan *Project API Key* yang diamankan menggunakan *Argon2id hashing*.
- **Zero-Plaintext-Recall Secret Architecture**: API Key klien dan kredensial AI provider hanya ditampilkan satu kali dalam memori saat pembuatan/rotasi dan dienkripsi saat disimpan menggunakan **AES-256-GCM**.
- **Admin Observability & Telemetry**: Dashboard privat (`/admin`) untuk memantau performa, latensi (*first chunk* & total durasi), volume request, status kuota, insiden penolakan (*pre-auth & rate limit rejection*), dan log audit.
- **Anti-Slop UI & Accessibility**: Antarmuka bersih tanpa dekorasi berlebih (*no glow, no blur, no decorative badges*), kontras tinggi, navigasi keyboard penuh, dan format angka telemetri `tabular-nums`.

---

## Arsitektur Sistem

```
[ Klien / OpenAI SDK / cURL ]
             │
             ▼
[ POST /v1/chat/completions ]
             │
             ├──► 1. API Key Guard (Autentikasi Argon2id Proyek)
             │
             ├──► 2. Pipeline Validator (Validasi JSON, Skema, Fingerprint)
             │
             ├──► 3. Admission Limiter (Cek Kuota Atomik RPM & Concurrency di MongoDB)
             │
             ├──► 4. Credential & Alias Resolver (Resolusi Alias Proyek -> Kredensial Enkripsi)
             │
             ├──► 5. Provider Adapter (Google Gemini / Antigravity Adapter)
             │
             ├──► 6. SSE Stream Handler / Non-Streaming JSON Formatter
             │
             └──► 7. Telemetry & Monitoring Logger (Pencatatan Latensi, Status, Token di MongoDB)
```

---

## Prasyarat

- **Node.js**: Versi `20.x` atau lebih baru
- **NPM**: Versi `10.x` atau lebih baru
- **MongoDB**: MongoDB Atlas Cluster (M0 Free Tier atau M10+ Production) atau instance lokal MongoDB >= 6.0
- **Google AI Studio API Key**: Kunci API Gemini untuk inferensi LLM

---

## Panduan Instalasi Cepat

### 1. Clone Repositori
```bash
git clone https://github.com/Degs1/agy-proxy.git
cd agy-proxy
```

### 2. Install Dependensi
```bash
npm install
```

### 3. Siapkan Variabel Lingkungan
Salin file `.env.example` menjadi `.env`:
```bash
cp .env.example .env
```

Isi variabel utama di dalam file `.env`:
```env
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB_NAME=antigravity_gateway
AUTH_SECRET=rahasia-sesi-admin-minimal-32-karakter-acak
ADMIN_EMAIL=admin@internal.net
TOKEN_ENCRYPTION_KEY=64_hex_characters_or_32_bytes_base64_encryption_key
GEMINI_API_KEY=AIzaSy...your-gemini-api-key
CRON_SECRET=token-rahasia-cron-internal
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

> **Tips:** Untuk membuat `TOKEN_ENCRYPTION_KEY` (AES-256-GCM 32-byte hex):
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

---

## Konfigurasi Environment (`.env`)

| Variabel | Tipe | Wajib | Keterangan & Contoh |
|---|---|---|---|
| `MONGODB_URI` | String | Ya | String koneksi MongoDB Atlas (`mongodb+srv://...`). |
| `MONGODB_DB_NAME` | String | Ya | Nama database (default: `antigravity_gateway`). |
| `AUTH_SECRET` | String | Ya | Kunci sesi cookie terenkripsi untuk portal admin (min. 32 karakter). |
| `ADMIN_EMAIL` | String | Ya | Alamat email administrator sistem. |
| `TOKEN_ENCRYPTION_KEY` | String | Ya | Kunci 32-byte (64 karakter hex) untuk enkripsi AES-256-GCM kredensial provider. |
| `GEMINI_API_KEY` | String | Ya | Kunci API resmi Google Gemini dari Google AI Studio. |
| `CRON_SECRET` | String | Ya | Token proteksi endpoint berkala / recovery worker. |
| `NEXT_PUBLIC_APP_URL` | String | Ya | Base URL gateway (misal `http://localhost:3000` atau URL domain Vercel). |
| `ANTIGRAVITY_CLIENT_ID` | String | Opsional | Kredensial OAuth Antigravity (jika fitur experimental diaktifkan). |
| `ANTIGRAVITY_CLIENT_SECRET` | String | Opsional | Rahasia OAuth Antigravity. |

---

## Inisialisasi Database & Bootstrap Admin

Sebelum menjalankan gateway, inisialisasi indeks koleksi database dan buat akun administrator pertama:

### 1. Inisialisasi & Verifikasi Indeks Koleksi
Jalankan skrip migrasi indeks MongoDB:
```bash
npm run db:deploy
```
*Perintah ini akan membuat indeks esensial (TTL monitoring, kunci pencarian proyek, index unik API key, dan rate limiter) serta memverifikasi kesiapannya.*

### 2. Bootstrap Akun Administrator
Jalankan skrip bootstrap untuk membuat akun admin pertama:
```bash
npm run auth:bootstrap admin@internal.net RahasiaAdmin123!
```
Jika tanpa argumen, skrip akan membuat akun default:
- **Email:** `admin@internal.net`
- **Password:** `AdminPassword123!`

---

## Menjalankan Server

### Mode Development
```bash
npm run dev
```
Akses portal admin melalui browser di: [http://localhost:3000/admin](http://localhost:3000/admin) *(otomatis mengarahkan ke halaman login jika belum terautentikasi)*.

### Mode Production Build
```bash
npm run build
npm run start
```

---

## Panduan Penggunaan API

Endpoint inferensi gateway dirancang identik dengan spesifikasi OpenAI Chat Completion API.

### OpenAI SDK (Python)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",  # atau https://domain-gateway.vercel.app/v1
    api_key="agk_live_xxxxxxxxxxxxxxxxxxxx"  # API key proyek yang dibuat di portal admin
)

# 1. Non-Streaming Response
response = client.chat.completions.create(
    model="gemini-2.5-flash",  # Atau alias model yang dikonfigurasi di proyek
    messages=[
        {"role": "system", "content": "Anda adalah asisten teknis yang ringkas."},
        {"role": "user", "content": "Jelaskan fungsi reverse proxy dalam 1 kalimat."}
    ]
)
print(response.choices[0].message.content)

# 2. Streaming Response (SSE)
stream = client.chat.completions.create(
    model="gemini-2.5-flash",
    messages=[{"role": "user", "content": "Tuliskan 3 tips optimasi database."}],
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### OpenAI SDK (Node.js / TypeScript)
```typescript
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: process.env.AGY_PROJECT_API_KEY, // Project API Key
});

async function main() {
  const completion = await openai.chat.completions.create({
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'Halo dari Node.js!' }],
    stream: true,
  });

  for await (const chunk of completion) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

main();
```

### cURL (Non-Streaming & SSE Streaming)

#### Non-Streaming
```bash
curl -X POST "http://localhost:3000/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer agk_live_your_project_key_here" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      { "role": "user", "content": "Sebutkan 3 pilar OOP." }
    ],
    "temperature": 0.7
  }'
```

#### Streaming SSE
```bash
curl -N -X POST "http://localhost:3000/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer agk_live_your_project_key_here" \
  -d '{
    "model": "gemini-2.5-flash",
    "messages": [
      { "role": "user", "content": "Buat puisi 2 bait tentang pemrograman." }
    ],
    "stream": true
  }'
```

### Healthcheck Endpoint
Periksa kesiapan konektivitas gateway dan database:
```bash
curl http://localhost:3000/api/health
```
Output respon:
```json
{
  "status": "healthy",
  "database": "connected",
  "timestamp": "2026-11-06T15:00:00.000Z"
}
```

---

## Admin Portal & Pengelolaan Proyek

Akses portal admin di `/admin/projects` untuk melakukan konfigurasi:

1. **Membuat Proyek Baru (`/admin/projects`)**:
   - Tentukan nama proyek, batas kuota RPM (*Requests per Minute*), dan batas konkuren maksimum.
   - Daftarkan alias model yang diizinkan untuk proyek tersebut.
2. **Membuat Kunci Akses Proyek (Project API Keys)**:
   - Generate kunci berawalan `agk_live_...`.
   - Simpan kunci langsung saat modal ditampilkan — kunci tidak akan dapat dilihat kembali setelah modal ditutup (*Zero-Plaintext-Recall*).
3. **Konfigurasi Kredensial Provider**:
   - Daftarkan API Key Gemini atau akun provider per proyek.
   - Kredensial disimpan terenkripsi dengan AES-256-GCM di database.
4. **Monitoring & Telemetri (`/admin/monitoring` & `/admin/overview`)**:
   - Pantau grafik throughput request, distribusi waktu respon (P50, P95, P99), insiden penolakan kuota (*Rate Limit Rejections*), dan kesalahan autentikasi (*Pre-auth 401 Rejections*).

---

## Daftar Perintah (NPM Scripts)

| Perintah | Deskripsi |
|---|---|
| `npm run dev` | Menjalankan server Next.js pada mode development (`http://localhost:3000`). |
| `npm run build` | Melakukan kompilasi produksi seluruh halaman dan API route Next.js. |
| `npm run start` | Menjalankan instance produksi hasil kompilasi. |
| `npm run lint` | Menjalankan Next.js ESLint checker. |
| `npm run db:init` | Membuat indeks koleksi MongoDB yang diperlukan gateway. |
| `npm run db:verify` | Memverifikasi ketersediaan dan integritas indeks di MongoDB Atlas. |
| `npm run db:deploy` | Menjalankan `db:init` diikuti `db:verify` sekaligus. |
| `npm run auth:bootstrap` | Melakukan inisialisasi akun administrator pertama di database. |
| `npm run test` | Menjalankan seluruh rangkaian tes: Vitest (komponen & limiter) + tes validasi pipeline. |
| `npm run test:watch` | Menjalankan Vitest dalam mode interaktif *watch*. |
| `npm run worker:recovery` | Menjalankan worker pemulihan status koneksi & lease limiter. |
| `npm run test:chat` | Menjalankan skrip simulasi pengujian chat completion lokal. |

---

## Panduan Deployment (Vercel + MongoDB Atlas)

Aplikasi dirancang sebagai *Next.js Monolith* yang siap di-deploy langsung ke Vercel tanpa server proxy perantara:

1. **Push ke GitHub**:
   Pastikan kode berada di branch `main` repositori GitHub Anda.
2. **Import Proyek di Vercel**:
   - Buka [Vercel Dashboard](https://vercel.com/) -> **Add New Project** -> Import repositori `agy-proxy`.
   - Framework preset otomatis terdeteksi sebagai **Next.js**.
   - Build Command: `npm run build`
   - Output Directory: `.next`
3. **Konfigurasi Environment Variables di Vercel**:
   Tambahkan semua variabel dari `.env` ke pengaturan **Environment Variables** proyek Vercel:
   - `MONGODB_URI`
   - `MONGODB_DB_NAME`
   - `AUTH_SECRET`
   - `ADMIN_EMAIL`
   - `TOKEN_ENCRYPTION_KEY`
   - `GEMINI_API_KEY`
   - `CRON_SECRET`
   - `NEXT_PUBLIC_APP_URL` (isi dengan domain produksi Vercel, misal `https://agy-proxy.vercel.app`)
4. **Konfigurasi Akses Jaringan MongoDB Atlas**:
   - Di MongoDB Atlas, buka **Network Access** -> **IP Access List**.
   - Tambahkan IP `0.0.0.0/0` (Allow Access from Anywhere) karena IP Vercel Serverless bersifat dinamis, atau gunakan integrasi resmi Vercel MongoDB Atlas.
   - Pastikan pengguna database memiliki hak baca & tulis (*readWrite*) pada database `antigravity_gateway`.
5. **Eksekusi Inisialisasi Database**:
   Jalankan `npm run db:deploy` dan `npm run auth:bootstrap` satu kali dari terminal lokal Anda yang terhubung ke URI MongoDB Atlas produksi.

---

## Prinsip Keamanan & Anti-Slop

- **Zero-Plaintext-Recall**: Kredensial rahasia (API Key & Provider Keys) tidak pernah disimpan dalam bentuk teks biasa dan langsung dihapus dari memori antarmuka pengguna setelah konfirmasi.
- **Argon2id Hashing**: Kunci API klien diverifikasi menggunakan algoritma *hashing memory-hard* Argon2id untuk mencegah serangan *brute-force* dan *timing attacks*.
- **Next.js SSE Lifecycle**: Penundaan pembukaan Response HTTP 200 hingga chunk pertama tiba memastikan bahwa error di awal proses dapat dilaporkan secara bersih sebagai status JSON HTTP standar, bukan aliran SSE yang korup.
- **MongoDB Atlas Latency Guard**: Penanganan jeda TTL MongoDB memastikan validasi kuota waktu nyata dihitung secara eksplisit pada tingkat transaksi aplikasi.
- **Anti-Slop UI Architecture**: Mengikuti pedoman desain berorientasi fungsi — tipografi `tabular-nums` untuk metrik telemetri, penghapusan efek estetika semu (*glow, blur, gradient slop*), kontras tinggi, dan aksesibilitas ramah pembaca layar (ARIA).

---

## Lisensi

Proyek ini dirilis di bawah lisensi [MIT](LICENSE).
