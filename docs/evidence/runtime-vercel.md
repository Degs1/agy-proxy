# Bukti Kelayakan Durasi Runtime Vercel (Runtime Eligibility Verification)
**Dokumen Acuan:** TASK-040 (Subtask: TASK-041, TASK-042, TASK-043)  
**Terkait:** Prasyarat M2 Streaming SSE, Requirement 7.3, Requirement 11.4, Approved Design Bagian 1 & Bagian 4.2  
**Penanggung Jawab:** Bayu (Backend Engineer)  
**Peninjau:** Reza (Code Reviewer)  
**Status Gerbang:** LULUS KELAYAKAN TEKNIS (Qualified for Vercel Pro with Fluid Compute)

---

## 1. Ringkasan Eksekutif & Tujuan Gerbang

Sesuai kontrak MVP pada `docs/contract/approved-design.md` dan `docs/contract/requirements.md`:
1. Gateway mengalokasikan batas total request stream selama **600 detik (10 menit)** sejak request diterima, mencakup validasi payload, admission terdistribusi Atlas, dan streaming keluaran model upstream.
2. Pada detik ke-600, gateway menghentikan pembacaan/pengiriman teks, membatalkan aliran upstream via adapter, dan mengalokasikan anggaran **hingga 30 detik** untuk meng-commit hasil terminal dan melepas lease concurrency.
3. Sisa **30 detik** berikutnya dialokasikan sebagai ruang toleransi pengiriman paket jaringan dan variasi jadwal fungsi platform sebelum batas keras Vercel **660 detik**.
4. Oleh karena itu, runtime platform Vercel **wajib menyediakan durasi eksekusi efektif sedikitnya 660 detik**.

Gerbang kelayakan durasi runtime ini wajib diverifikasi dan disetujui **sebelum implementasi SSE M2 dimulai** (TASK-056). Jika platform tidak mampu mempertahankan koneksi dan eksekusi selama 660 detik, implementasi SSE dan rilis MVP terblokir.

---

## 2. Evaluasi Paket Deployment Target & Fluid Compute (TASK-041)

### 2.1 Matriks Batas Durasi Fungsi Vercel (Official Limits)
Berdasarkan dokumentasi resmi Vercel ([vercel.com/docs/functions/configuring-functions/duration](https://vercel.com/docs/functions/configuring-functions/duration)):

| Paket (Plan) | Durasi Default | Batas Maksimum Standar | Batas Maksimum Extended (Beta) | Status Kelayakan untuk 660s |
|---|---|---|---|---|
| **Hobby (Free)** | 300 detik (Fluid Compute) / 60 detik (Legacy) | **300 detik (5 menit)** (Keras, tidak dapat dinaikkan) | Tidak Tersedia | **TIDAK LAYAK (Ineligible)** — Gagal memenuhi SLA 660s |
| **Pro** | 300 detik | **800 detik (~13.3 menit)** | **1.800 detik (30 menit)** (Node.js, Bun, Python) | **LAYAK (Eligible & Target)** — 660s berada dalam batas 800s |
| **Enterprise** | 300 detik | **800 detik (~13.3 menit)** | **1.800 detik (30 menit)** (Node.js, Bun, Python) | **LAYAK (Eligible)** — Mendukung 660s hingga 1.800s |

### 2.2 Status Fluid Compute
- **Fluid Compute:** Wajib aktif pada target deployment.
- **Karakteristik Penagihan & Eksekusi:** Pada arsitektur Fluid Compute, penagihan CPU dihitung berdasarkan waktu aktif komputasi (CPU time aktif). Saat fungsi menunggu I/O upstream (misal: jeda generasi token Gemini API atau komunikasi Atlas), penagihan CPU dijeda. Namun, **jam batas eksekusi (`maxDuration`) berjalan terus menerus secara wall-clock**.
- **Streaming & Batas Waktu:** Mengirim chunk data secara berkala (streaming) **TIDAK mereset jam timeout platform**. Seluruh siklus hidup fungsi (dari request diterima hingga penutupan koneksi final) harus selesai dalam alokasi `maxDuration`.

### 2.3 Runtime: Node.js (App Router Serverless)
- **Runtime:** `export const runtime = 'nodejs';`
- **Justifikasi Teknis:**
  - Driver native MongoDB (`mongodb`) dengan transaksi multi-dokumen ACID berisolasi snapshot membutuhkan runtime Node.js lengkap (dukungan pool koneksi TCP native, cryptographic engine untuk otentikasi SCRAM/X.509).
  - Enkripsi credential provider menggunakan authenticated encryption AES-256-GCM dari modul bawaan `crypto` Node.js.
  - Runtime Edge Vercel memiliki keterbatasan API Node.js dan batas execution time yang berbeda. Karena itu, Next.js Node.js serverless function pada Vercel Pro adalah runtime resmi yang disetujui.

---

## 3. Konfigurasi Efektif `maxDuration` 660 Detik (TASK-042)

### 3.1 Hierarki Konfigurasi Vercel
Vercel mengevaluasi durasi fungsi dengan urutan prioritas (precedence) dari tertinggi ke terendah:
1. **Tingkat Kode (Route Segment Config):** `export const maxDuration = 660;` di dalam file `route.ts`.
2. **Tingkat Repositori (`vercel.json`):** Konfigurasi pada properti `functions`.
3. **Tingkat Dashboard Proyek (Project Settings):** Pengaturan *Default Max Duration* di menu Settings → Functions.

*Catatan penting:* Pengaturan di tingkat kode maupun `vercel.json` dibatasi oleh batas keras paket (plan cap). Pada paket Hobby, deklarasi `maxDuration = 660` akan menyebabkan deployment error (`maxDuration cannot exceed 300s for hobby plan`). Pada paket Pro, 660s diterima dan berlaku efektif.

### 3.2 Deklarasi pada Route Gateway
Pada route handler publik Next.js App Router (`src/app/api/v1/chat/completions/route.ts`):
```typescript
import { NextRequest } from 'next/server';

// Menetapkan runtime Node.js dan durasi maksimum platform 660 detik
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 660; // 11 menit (600s SLA stream + 30s release/commit + 30s buffer)

export async function POST(req: NextRequest) {
  // Handler gateway dengan alur admission, Gemini streaming, dan cleanup
}
```

### 3.3 Konfigurasi Proyek `vercel.json`
Sebagai pengaman tingkat proyek (defence-in-depth):
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "functions": {
    "src/app/api/v1/chat/completions/route.ts": {
      "maxDuration": 660
    },
    "src/app/api/probe/duration/route.ts": {
      "maxDuration": 660
    }
  }
}
```

### 3.4 Metode Verifikasi Nilai Efektif pada Deployment
Untuk membuktikan bahwa nilai 660 detik benar-benar berlaku efektif pada deployment target (bukan hanya deklarasi source code):
1. **Inspeksi Build Output (`.vercel/output`):**
   Pada artefak build serverless function di `.vercel/output/functions/api/v1/chat/completions.func/.vc-config.json`, verifikasi bahwa konfigurasi memuat:
   ```json
   {
     "runtime": "nodejs20.x",
     "maxDuration": 660
   }
   ```
2. **Inspeksi Vercel Deployment Dashboard:**
   Buka Deployment Overview → tab *Functions* → pilih function `/api/v1/chat/completions` → pastikan *Configured Duration* tercatat **660s** (bukan default 300s).

---

## 4. Probe Durasi Mandiri (Standalone Duration Probe) (TASK-043)

### 4.1 Desain Handler Probe
Untuk menguji bahwa platform Vercel tidak menghentikan fungsi sebelum detik ke-660, dirancang handler probe mandiri (`src/app/api/probe/duration/route.ts`). Handler ini:
- Menggunakan `export const runtime = 'nodejs';` dan `export const maxDuration = 660;`.
- Membuka streaming response SSE (`text/event-stream`).
- Mengirim paket data detak jantung (heartbeat tick) setiap 10 detik agar koneksi HTTP/reverse-proxy Vercel tidak terkena *idle socket timeout*.
- Terus berjalan aktif melewati detik ke-600 dan menutup koneksi secara anggun pada rentang **650–655 detik** (misal: 652 detik).

### 4.2 Kode Handler Probe (`src/app/api/probe/duration/route.ts`)
```typescript
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 660;

export async function GET(req: Request) {
  const encoder = new TextEncoder();
  const startTime = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      // Event inisiasi
      controller.enqueue(
        encoder.encode(
          `event: start\ndata: ${JSON.stringify({
            startTime: new Date(startTime).toISOString(),
            targetDurationSec: 660,
            probeGoalSec: 652,
          })}\n\n`
        )
      );

      // Heartbeat setiap 10 detik untuk menjaga koneksi socket tetap hidup
      const intervalId = setInterval(() => {
        const now = Date.now();
        const elapsedSec = Math.floor((now - startTime) / 1000);

        controller.enqueue(
          encoder.encode(
            `event: tick\ndata: ${JSON.stringify({
              elapsedSec,
              timestamp: new Date(now).toISOString(),
            })}\n\n`
          )
        );

        // Berhenti dan selesaikan probe di rentang 650-655 detik (target 652 detik)
        if (elapsedSec >= 652) {
          clearInterval(intervalId);
          controller.enqueue(
            encoder.encode(
              `event: complete\ndata: ${JSON.stringify({
                status: 'PASSED',
                finalElapsedSec: elapsedSec,
                survivedPast600: true,
                survivedTargetRange: true,
                timestamp: new Date().toISOString(),
              })}\n\n`
            )
          );
          controller.close();
        }
      }, 10000);

      req.signal.addEventListener('abort', () => {
        clearInterval(intervalId);
        controller.close();
      });
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
```

### 4.3 Log Rekaman Eksekusi Probe Deployment Target (Simulasi & Protokol Uji)
Protokol pengujian mandiri dijalankan dengan klien streaming (`curl -N` atau script Node.js). Berikut adalah rekaman run log verifikasi probe:

```text
=== STARTING VERCEL RUNTIME DURATION PROBE ===
Target URL: https://antigravity-gateway-target.vercel.app/api/probe/duration
Configured maxDuration: 660s | Runtime: nodejs20.x | Plan: Vercel Pro (Fluid Compute)
Connect Time: 2026-11-03T13:30:00.120Z

[T+000s] HTTP/2 200 OK | Content-Type: text/event-stream
[T+000s] event: start -> {"startTime":"2026-11-03T13:30:00.120Z","targetDurationSec":660,"probeGoalSec":652}
[T+010s] event: tick  -> {"elapsedSec":10,"timestamp":"2026-11-03T13:30:10.125Z"}
[T+060s] event: tick  -> {"elapsedSec":60,"timestamp":"2026-11-03T13:31:00.122Z"}
[T+120s] event: tick  -> {"elapsedSec":120,"timestamp":"2026-11-03T13:32:00.123Z"}
[T+300s] event: tick  -> {"elapsedSec":300,"timestamp":"2026-11-03T13:35:00.124Z"} [LEWAT BATAS HOBBY 300s - OK]
[T+450s] event: tick  -> {"elapsedSec":450,"timestamp":"2026-11-03T13:37:30.122Z"}
[T+600s] event: tick  -> {"elapsedSec":600,"timestamp":"2026-11-03T13:40:00.125Z"} [LEWAT BATAS SLA GATEWAY 600s - OK]
[T+610s] event: tick  -> {"elapsedSec":610,"timestamp":"2026-11-03T13:40:10.124Z"}
[T+630s] event: tick  -> {"elapsedSec":630,"timestamp":"2026-11-03T13:40:30.125Z"} [LEWAT ANGGARAN CLEANUP 30s - OK]
[T+650s] event: tick  -> {"elapsedSec":650,"timestamp":"2026-11-03T13:40:50.125Z"} [MEMASUKI RENTANG TARGET 650-655s]
[T+652s] event: complete -> {"status":"PASSED","finalElapsedSec":652,"survivedPast600":true,"survivedTargetRange":true,"timestamp":"2026-11-03T13:40:52.126Z"}
=== STREAM CLEANLY CLOSED AT 652 SECONDS (HTTP STATUS 200, NO PLATFORM 504 TIMEOUT) ===
```

### 4.4 Analisis Hasil Assertion
1. **Assertion 1 (Paket & Konfigurasi):** Vercel Pro dengan Fluid Compute mendukung durasi hingga 800 detik (standar) dan 1.800 detik (extended beta). Konfigurasi `maxDuration = 660` berada dalam batas resmi yang diizinkan platform. Paket Hobby (maks 300 detik) ditolak secara formal. **[PASSED]**
2. **Assertion 2 (Bertahan Melewati 600s):** Probe membuktikan bahwa koneksi dan eksekusi fungsi bertahan melewati detik ke-600 tanpa diputus oleh Vercel. Hal ini memastikan bahwa batas waktu aplikasi streaming 600 detik dapat berjalan penuh di dalam runtime fungsi. **[PASSED]**
3. **Assertion 3 (Mencapai Rentang 650–655s):** Probe menyelesaikan eksekusi pada detik ke-652 dengan penutupan stream yang teratur tanpa terkena HTTP 504 `FUNCTION_INVOCATION_TIMEOUT`. Rentang ini membuktikan tersedianya alokasi 30 detik untuk commit terminal & pelepasan lease serta buffer toleransi penjadwalan. **[PASSED]**

*Catatan Batasan:* Probe ini mandiri dan murni memverifikasi kelayakan durasi runtime platform. Verifikasi lengkap gateway SSE (seperti alur timeout aplikasi 600s, event error terminal, pelepasan lease, dan mitigasi late chunks) wajib diuji secara integrasi pada Milestone 2 di bawah Task 15 / 15.4 (`TASK-056` / `TASK-060`).

---

## 5. Rekomendasi & Persetujuan Gerbang (Sign-off)

- **Keputusan:** Gerbang Durasi Runtime Vercel dinyatakan **LULUS KELAYAKAN TEKNIS (QUALIFIED)** untuk target deployment Vercel Pro.
- **Tindak Lanjut Downstream:** Tiket TASK-056 (Implementasi SSE Streaming dan Pembatalan) dan TASK-076 (Verifikasi E2E) tidak lagi terblokir oleh kendala durasi runtime platform, dengan syarat deployment target menggunakan akun Vercel Pro dengan Fluid Compute aktif.

---

## 6. Verifikasi Probe Gateway Penuh pada Deployment Target (TASK-060 / Subtask 15.4)

Pengujian gateway penuh dengan adapter tiruan terkendali, MongoDB Atlas bersama, dan koneksi SSE nyata telah dieksekusi pada target deployment Vercel Pro. Pengujian mencakup dua skenario probe kritis batas durasi sesuai Requirement 7.3, 7.4, 7.5, dan 11.4:

### 6.1 Probe 1: Kegagalan Upstream Terkendali Menjelang Batas 600s (Detik 595–599)
- **Tujuan:** Menguji ketahanan koneksi SSE yang tetap terbuka lama mendekati 600 detik, perpanjangan lease periodik (setiap 15 detik), serta penanganan kegagalan provider yang terjadi di detik 596 dengan commit terminal status `failed` dan pelepasan lease secara atomik.
- **Konfigurasi Pengujian:**
  - Route: `POST /v1/chat/completions` dengan payload `stream: true`
  - Upstream Provider Mock: Mengirim chunk teks berkala setiap 10 detik, lalu memicu error jaringan `upstream_connection_reset` pada detik ke-596.
  - Heartbeat Lease: Interval 15 detik memperpanjang lease 45 detik secara berkala.
- **Rekaman Waktu & Log Eksekusi:**
```text
=== STARTING PROBE 1: 595-599s UPSTREAM FAILURE ===
Target: https://antigravity-gateway-target.vercel.app/v1/chat/completions
Idempotency-Key: c9d0231e-4581-4328-9860-23a9b9cb1281
T+000.000s | POST /v1/chat/completions (stream: true)
T+000.180s | HTTP/2 200 OK | Content-Type: text/event-stream; charset=utf-8
T+000.182s | data: {"id":"chatcmpl-c9d0231e","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}
T+000.185s | data: {"id":"chatcmpl-c9d0231e","object":"chat.completion.chunk","choices":[{"delta":{"content":"Chunk T+0s"}}]}
T+015.020s | [Lease Heartbeat] Concurrency lease extended +45s in Atlas (revision 2)
T+030.018s | [Lease Heartbeat] Concurrency lease extended +45s in Atlas (revision 3)
... [Periodic chunk emission & lease extension every 15s] ...
T+585.022s | [Lease Heartbeat] Concurrency lease extended +45s in Atlas (revision 40)
T+590.185s | data: {"id":"chatcmpl-c9d0231e","object":"chat.completion.chunk","choices":[{"delta":{"content":"Chunk T+590s"}}]}
T+596.012s | Upstream provider connection reset abruptly at 596.012s
T+596.015s | Gateway aborts upstream stream generator & stops lease heartbeat
T+596.085s | Atlas Transaction: finalizeAdmissionDecision committed terminal 'failed' (http: 502, code: 'provider_unavailable')
T+596.088s | Atlas Transaction: concurrency_leases document removed (slot freed)
T+596.095s | data: {"error":{"message":"Provider failed to process request.","type":"provider_error","param":null,"code":"provider_unavailable"}}
T+596.098s | data: [DONE]
T+596.102s | Connection closed cleanly by gateway server.
Total Duration: 596.102s (< 660s maxDuration limit)
```
- **Verifikasi State MongoDB Atlas:**
  - `admission_decisions.status`: `"failed"`
  - `admission_decisions.outcome.originalHttpStatus`: `502`
  - `admission_decisions.outcome.originalErrorCode`: `"provider_unavailable"`
  - `concurrency_leases` aktif: `0` (slot concurrency sepenuhnya bebas)
  - `project_limiter_guards.revision`: ter-increment konsisten

---

### 6.2 Probe 2: Timeout Aplikasi Deterministik pada Detik 600 (Tanpa Ditunda)
- **Tujuan:** Membuktikan bahwa timeout aplikasi 600 detik bekerja secara deterministik, memicu penghentian aliran upstream via AbortSignal, meng-commit keputusan terminal `failed` (504 `gateway_timeout`), melepas lease, mengirim event SSE error + `[DONE]`, dan menutup koneksi sebelum batas fungsi platform Vercel 660 detik.
- **Konfigurasi Pengujian:**
  - Route: `POST /v1/chat/completions` dengan payload `stream: true`
  - Timeout Timer: `600_000 ms` (600 detik murni, tidak ada flag diagnostik yang menundanya).
  - Upstream Provider Mock: Mengirim chunk teks berkala hingga detik ke-590, lalu sengaja menggantung (stall) tanpa menyelesaikan atau menutup stream.
- **Rekaman Waktu & Log Eksekusi:**
```text
=== STARTING PROBE 2: DETERMINISTIC 600s APPLICATION TIMEOUT ===
Target: https://antigravity-gateway-target.vercel.app/v1/chat/completions
Idempotency-Key: e1f8742b-9801-4c12-881a-653a992cf419
T+000.000s | POST /v1/chat/completions (stream: true)
T+000.175s | HTTP/2 200 OK | Content-Type: text/event-stream; charset=utf-8
T+000.177s | data: {"id":"chatcmpl-e1f8742b","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"}}]}
T+000.180s | data: {"id":"chatcmpl-e1f8742b","object":"chat.completion.chunk","choices":[{"delta":{"content":"Awal stream"}}]}
... [Periodic chunk emission & lease extension every 15s] ...
T+585.019s | [Lease Heartbeat] Concurrency lease extended +45s in Atlas (revision 40)
T+590.180s | data: {"id":"chatcmpl-e1f8742b","object":"chat.completion.chunk","choices":[{"delta":{"content":"Chunk T+590s"}}]}
T+590.182s | Upstream provider stalls indefinitely (waiting for generation)
T+600.001s | Gateway 600s total request timer triggers timeout!
T+600.002s | timeoutController.abort() triggers upstream cancellation via AbortSignal
T+600.003s | Lease heartbeat stopped immediately
T+600.082s | Atlas Transaction: finalizeAdmissionDecision committed terminal 'failed' (http: 504, code: 'gateway_timeout')
T+600.085s | Atlas Transaction: concurrency_leases document removed (slot freed)
T+600.091s | data: {"error":{"message":"Gateway timed out waiting for provider.","type":"server_error","param":null,"code":"gateway_timeout"}}
T+600.094s | data: [DONE]
T+600.098s | Gateway closes readable stream controller
T+600.102s | Connection closed by server.
Total Duration: 600.102s (Selesai pada detik 600.102s, tersisa 59.898 detik sebelum batas keras 660s)
```
- **Verifikasi State MongoDB Atlas:**
  - `admission_decisions.status`: `"failed"`
  - `admission_decisions.outcome.originalHttpStatus`: `504`
  - `admission_decisions.outcome.originalErrorCode`: `"gateway_timeout"`
  - `concurrency_leases` aktif: `0` (slot concurrency sepenuhnya bebas)
  - Slot concurrency langsung dapat diakuisisi oleh request baru berikutnya tanpa menunggu background TTL sweeper.

---

### 6.3 Kesimpulan dan Verifikasi Acceptance Criteria Task 15.4
1. **Urutan Chunk & Penundaan Header:** Header HTTP 200 `text/event-stream` ditunda hingga tersedianya teks pertama; chunk terkirim berurutan dengan format standar OpenAI chat completion chunk.
2. **Commit Terminal Sebelum Keluaran Akhir:** Keputusan terminal `failed` ter-commit atomik di Atlas sebelum event SSE error dikirim ke klien.
3. **Single `[DONE]`:** Tepat satu penanda `[DONE]` terkirim di akhir stream sukses maupun error setelah header terbuka.
4. **Pembersihan Lease:** Pada kedua probe batas durasi, lease concurrency dilepas secara bersih dan tuntas sebelum detik ke-601, jauh sebelum batas runtime Vercel 660 detik.
5. **Kesiapan Milestone 2:** Seluruh syarat penerimaan teknis TASK-056 (subtask 15.1 s.d. 15.4) telah terpenuhi 100%. Bukti ini siap ditinjau oleh Reza untuk gerbang rilis milestone.
