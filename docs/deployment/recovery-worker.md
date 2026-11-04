# Panduan Deployment Produksi: Render Background Worker (Recovery Sweeper)

Dokumen ini mendefinisikan arsitektur, konfigurasi layanan, prosedur deploy, serta mitigasi operasional untuk **Background Lease Recovery Worker** pada gateway LLM Antigravity.

---

## 1. Arsitektur & Peran Layanan

Dalam sistem terdistribusi Antigravity Gateway:
- **Aplikasi Web / Gateway:** Dijalankan di Vercel (Serverless Edge/Node.js Functions).
- **Background Recovery Worker:** Dijalankan di **Render Background Worker** sebagai layanan mandiri (long-running process).

```
                      ┌────────────────────────────────────────┐
                      │             MongoDB Atlas              │
                      │  - concurrency_leases                  │
                      │  - admission_decisions                 │
                      │  - project_limiter_guards              │
                      │  - worker_heartbeats                   │
                      └──────────────▲──────────────────▲──────┘
                                     │                  │
                guarded transactions │                  │ guarded transactions
                                     │                  │
               ┌─────────────────────┴───────┐   ┌──────┴──────────────────────┐
               │ Render Background Worker #1 │   │ Render Background Worker #2 │
               │   (Primary Instance)        │   │   (High Availability Peer)  │
               │   - Scan tiap 5 detik       │   │   - Scan tiap 5 detik       │
               │   - Heartbeat ke Atlas      │   │   - Heartbeat ke Atlas      │
               └─────────────────────────────┘   └─────────────────────────────┘
```

### Mengapa Terpisah dari Vercel?
1. Vercel adalah serverless environment dengan masa hidup fungsi terbatas per request (ephemeral execution) dan tidak mendukung infinite background loop.
2. MongoDB Atlas TTL background monitor memiliki latensi eksekusi 60–120 detik. Pemulihan kapasitas concurrency slot wajib presisi pada batas tepat 45 detik tanpa bergantung pada kedatangan request pengguna baru.
3. Dua (2) instance Render Background Worker berbayar (continuous compute) menjamin pemulihan concurrency 100% deterministik dan memiliki failover instan jika salah satu instance mati atau mengalami restart.

---

## 2. Spesifikasi Layanan Render

| Parameter | Nilai / Konfigurasi | Keterangan |
|---|---|---|
| **Service Type** | Background Worker | Layanan non-HTTP tanpa port binding publik |
| **Name** | `agy-gateway-recovery-worker` | Nama service di Render Dashboard |
| **Region** | Sesuai region cluster MongoDB Atlas (misal: `Oregon (US-West)` / `Frankfurt`) | Menekan latensi jaringan Atlas ke tingkat sub-10ms |
| **Instance Type / Tier** | Starter atau Standard (Paid Tier) | Mencegah idle spin-down (wajib berjalan 24/7) |
| **Instance Count** | `2` instance | High-availability redundancy |
| **Environment** | Node | Runtime LTS Node.js 22.x |
| **Build Command** | `npm install` | Instalasi dependensi production (`tsx` terdaftar di runtime `dependencies`) |
| **Start Command** | `npm run worker:recovery` | Menjalankan `tsx src/workers/recovery-worker.ts` |
| **Auto-Deploy** | `Yes` (pada branch `master`) | CI/CD otomatis saat release |

---

## 3. Environment Variables & Secrets

Environment variables wajib dikonfigurasi melalui **Render Dashboard → Environment → Secret Files / Environment Variables**:

| Variable | Tipe | Deskripsi & Contoh |
|---|---|---|
| `NODE_ENV` | String | `production` |
| `MONGODB_URI` | Secret | URI koneksi MongoDB Atlas (misal: `mongodb+srv://gateway_worker:<password>@cluster0.abcde.mongodb.net/?retryWrites=true&w=majority`) |
| `MONGODB_DB_NAME` | Secret | Nama database produksi (misal: `antigravity_gateway_prod`) |

> [!IMPORTANT]
> Jangan pernah meng-hardcode kredensial Atlas di repository. Seluruh kredensial diinjeksi melalui Render Secrets Manager.

---

## 4. Mekanisme Keamanan Multi-Instance (Concurrency Safety)

Ketika dua instance worker berjalan serentak dan memindai setiap 5 detik:
1. **Serialisasi Transaksi Per-Project:**
   Setiap transaksi pemulihan diawali dengan memutakhirkan `project_limiter_guards` via `touchProjectLimiterGuard(db, projectId, session)`. Ini mengunci dan menserialisasikan eksekusi per project di level MongoDB snapshot majority.
2. **Idempotensi Pembersihan Lease:**
   Penyapuan lease menggunakan query atomik:
   `find({ projectId, expiresAt: { $lte: serverTime } })`
   dan
   `updateOne({ _id: decision._id, status: 'running' })`.
   Jika Instance #1 telah menyelesaikan transisi untuk suatu lease kedaluwarsa, Instance #2 yang membaca bersamaan akan mendapati dokumen sudah berstatus `lease_expired` atau lease telah terhapus, sehingga mutasi dilewati secara aman tanpa error atau duplikasi.
3. **Heartbeat & Metrik Independen:**
   Setiap instance mencatat identitas unik `instanceId` pada koleksi `worker_heartbeats`, mencakup timestamp awal scan (`lastScanStartedAt`), heartbeat terakhir (`lastHeartbeatAt`), serta durasi pemindaian.

---

## 5. Penghentian Tertib (Graceful Shutdown pada `SIGTERM`)

Ketika Render melakukan redeploy, rolling update, atau restart instance:
1. Render mengirim sinyal `SIGTERM` ke proses worker.
2. Handler `SIGTERM` menangkap sinyal:
   - Menghentikan timer scan berikutnya (`clearInterval`).
   - Menyelesaikan siklus scan aktif bila sedang berjalan.
   - Mengubah status instance di `worker_heartbeats` menjadi `'stopped'`.
   - Menutup koneksi MongoClient secara tertib (`closeDatabaseConnection()`).
   - Keluar dengan kode `0` (`process.exit(0)`).
3. Jika graceful shutdown selesai dalam batas toleransi Render (30 detik), proses berhenti tanpa adanya pemutusan transaksi menggantung.

---

## 6. Prosedur Deploy (Step-by-Step)

### A. Melalui Render Dashboard
1. Buka [dashboard.render.com](https://dashboard.render.com).
2. Klik **New +** → Pilih **Background Worker**.
3. Hubungkan repositori GitHub/GitLab: `sokudo/agy-gateway`.
4. Isi konfigurasi:
   - **Name:** `agy-gateway-recovery-worker`
   - **Region:** Pilih region yang sama dengan cluster MongoDB Atlas.
   - **Branch:** `master`
   - **Build Command:** `npm install`
   - **Start Command:** `npm run worker:recovery`
   - **Plan:** `Starter` atau `Standard` (Paid tier).
5. Pada bagian **Scaling**, naikkan jumlah instance menjadi `2`.
6. Tambahkan Environment Variables:
   - `MONGODB_URI`: `<Kredensial Atlas>`
   - `MONGODB_DB_NAME`: `<Database Name>`
   - `NODE_ENV`: `production`
7. Klik **Create Background Worker**.

### B. Verifikasi Log Startup
Pantau tab **Logs** di Render. Pastikan muncul output:
```text
[RecoveryWorker] Starting background lease recovery worker...
[RecoveryWorker] Worker instance recovery-render-worker-1 started. Scanning every 5s.
```

---

## 7. Ambang Batas Alert Operasional & Monitoring

Kesehatan background worker dipantau secara otomatis melalui data pada koleksi `worker_heartbeats`. Sistem alarm operasional wajib dipasang dengan kriteria:

1. **`no_healthy_heartbeat_15s` (Critical):**
   Tidak ada rekaman heartbeat sehat dari instance aktif selama 15 detik. Mengindikasikan proses hang, crash fatal, atau kegagalan jaringan Atlas.
2. **`scan_interval_exceeded_10s` (Warning):**
   Jeda antara awal pemindaian melebihi 10 detik (batas SLA sehat adalah 5 detik). Mengindikasikan starvation CPU atau latensi transaksi tinggi.
3. **`repeated_transaction_failures` (Critical):**
   Instance mengalami kegagalan transaksi berulang (`consecutiveErrors >= 3`).
4. **`backlog_expired_leases` (Warning/Critical):**
   Akumulasi lease kedaluwarsa di koleksi `concurrency_leases` yang belum terpulihkan.
