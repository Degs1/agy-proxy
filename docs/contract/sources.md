# Sumber Kontrak MVP (Sources Document)

Dokumen ini mencatat metadata, asal-usul, versi, tanggal persetujuan, dan integritas hash dari tiga dokumen acuan utama yang mengunci kontrak pengembangan MVP Antigravity Gateway.

Arsip dan matriks ini menjadi kontrak resmi yang dipakai validator, implementasi, dan pengujian.

---

## 1. Ringkasan Status Sumber

| Dokumen | Path Repositori | Status Persetujuan | Hash Git Blob (Acuan Objek Git) | Normalized UTF-8 LF (Acuan Konten SHA-256) |
|---|---|---|---|---|
| **Requirements Document** | `docs/contract/requirements.md` | Disetujui (Approved) | `49ad505556c00df4515202be6360ef6564d260c8` | `480d0d32ce0ddf1ef13008b27b4f11d6b8d0926ed23748260880db625c6d444d` |
| **Approved Design** | `docs/contract/approved-design.md` | Disetujui (Approved) | `00c70a3d72490c99281e72333139bf101d296d54` | `b27b532e2a0128d9a9aa626e5b256260639a95e2c9bcd564cfc944b6f16e21fa` |
| **PRD Baseline** | `docs/PRD.md` | Baseline Diterima | `3ac0deaa8519dc256d261baf5765ed48a06ac217` | `628fb4e048ecae814bbaa4f8d9214cffc21b7c8474f39514449cc563a95cdc8b` |

### 1.1 Dokumen Matriks Kontrak dan Spesifikasi Pengujian

| Dokumen | Path Repositori | Status Dokumen | Hash Git Blob (Acuan Objek Git) | Normalized UTF-8 LF (Acuan Konten SHA-256) |
|---|---|---|---|---|
| **Test Matrix** | `docs/contract/test-matrix.md` | Revisi Koreksi Audit TASK-091 (Menunggu Audit Ulang) | `92d53dcaa61fbc2160a7dead76b1eb0b7277e32f` | `a31144208e2fdb1c49d7ada2d06eef2cbfe70397d2c33f98ad4c78c4cb3ddb7e` |
| **Decision Matrix** | `docs/contract/decision-matrix.md` | Rekonsiliasi Terkunci (Menunggu Audit Ulang) | `7bb6ba9d5ff8b2876c1317835abea882fc3731b6` | `9937d64ff560d1570fb7ba9a2e827664477ec2eec80a76717c1cef9c8f6f4c10` |

> **Status Keterblokiran Kontrak:**  
> Seluruh dokumen sumber telah tersedia dan diarsipkan secara lengkap di repositori kerja dengan integritas hash deterministik yang independen dari format akhir baris (*line ending*). **Kontrak MVP TIDAK TERBLOKIR DARI SISI DOKUMEN SUMBER**, dan saat ini berada pada tahap **Menunggu Audit Ulang Formal Reza (TASK-091)** atas koreksi tiga temuan audit `review.md` sebelum persetujuan formal dan pembekuan kontrak (TASK-004) dapat disahkan untuk membuka implementasi downstream (TASK-007 s.d. TASK-086).

---

## 2. Rincian Pelacakan Sumber (Traceability Details)

### 2.1 Sumber 1: Requirements Document

- **Berkas Repositori:** `docs/contract/requirements.md`
- **Tipe Dokumen:** Spesifikasi Kebutuhan Fungsional & Kriteria Penerimaan MVP (Kiro-style Requirements Document)
- **Asal Dokumen:** Raka (Project Manager), sesi perencanaan `aa2dde2e-a701-42ae-9cad-d0e6ccf8b60e`
- **Versi / Iterasi:** Versi final revisi (rollout `01a1a116-8850-7bb3-9a2f-ed5fded1e4f9`, iterasi respons terhadap review Reza)
- **Tanggal Persetujuan:** 2026-11-03 11:12:08 UTC
- **Peninjau (Reviewer):** Reza (Code Reviewer)
- **Hash Integritas Terverifikasi:**
  - **Git Blob Hash (Acuan Tunggal Git):** `49ad505556c00df4515202be6360ef6564d260c8`
  - **Normalized UTF-8 LF SHA-256 (Acuan Konten Lintas OS):** `480d0d32ce0ddf1ef13008b27b4f11d6b8d0926ed23748260880db625c6d444d`
  - *Raw Binary / Windows CRLF SHA-256 (Informasional lokal):* `37bf6e42069ac73b3b55c610e942126a68601e1381044b48493e7da0023852d2`
- **Cakupan Utama:**
  - Definisi 11 Requirement bernomor (Requirement 1 s.d. 11)
  - Detail Acceptance Criteria Must untuk M1, M2, dan M3
  - Aturan validasi payload ketat (1 MiB, 1-64 pesan, UTF-8 32 KiB)
  - Penegakan urutan peran pesan (leading system, user, bergantian, diakhiri user)
  - Batas parameter numerik (`temperature` 0..2, `max_tokens` 1..8192, `stream` boolean)
  - Batas rate limiting fixed window 1 menit UTC (60 RPM) dan 5 concurrency slot
  - Model lease concurrency 45 detik dengan renewal tiap 15 detik

### 2.2 Sumber 2: Approved Design

- **Berkas Repositori:** `docs/contract/approved-design.md`
- **Tipe Dokumen:** Spesifikasi Desain Arsitektur, Model Data, dan Kontrak Sistem (Kiro-style Design Document)
- **Asal Dokumen:** Raka (Project Manager) & tim teknik, sesi perencanaan `aa2dde2e-a701-42ae-9cad-d0e6ccf8b60e`
- **Versi / Iterasi:** Versi final revisi (rollout `01a1a137-7138-7b21-a04e-4f7f68c55933`, iterasi respons terhadap review Reza)
- **Tanggal Persetujuan:** 2026-11-03 11:47:59 UTC
- **Peninjau (Reviewer):** Reza (Code Reviewer)
- **Hash Integritas Terverifikasi:**
  - **Git Blob Hash (Acuan Tunggal Git):** `00c70a3d72490c99281e72333139bf101d296d54`
  - **Normalized UTF-8 LF SHA-256 (Acuan Konten Lintas OS):** `b27b532e2a0128d9a9aa626e5b256260639a95e2c9bcd564cfc944b6f16e21fa`
  - *Raw Binary / Windows CRLF SHA-256 (Informasional lokal):* `82ced9690941be7edf819277efbc771efa20410943d4604f8418d7932fe3f096`
- **Cakupan Utama:**
  - Arsitektur Next.js App Router monolith + serverless di Vercel
  - Koneksi langsung ke MongoDB Atlas (tanpa VPS, tanpa Docker Compose lokal/prod)
  - Serialisasi per-project berbasis dokumen guard transaksi Atlas
  - Skema data MongoDB Atlas (users, sessions, projects, api_keys, accounts, aliases, request_decisions, leases, request_logs, preauth_rejections)
  - Mekanisme sidik payload idempotensi kanonis (SHA-256)
  - Kontrak REST publik `POST /v1/chat/completions`, `GET /v1/models`
  - Kontrak administrasi dan proteksi CSRF `__Host-admin_session` + `X-CSRF-Token`

### 2.3 Sumber 3: Product Requirements Document (PRD)

- **Berkas Repositori:** `docs/PRD.md`
- **Tipe Dokumen:** PRD Baseline Aplikasi Antigravity Gateway v1.0
- **Asal Dokumen:** Degs1 (Product Owner / Stakeholder)
- **Versi / Commit Git:** Commit `f24cb08e186ad93495f42bcc909d82e00d7094d5` (Initial commit, branch `master`)
- **Tanggal Dokumen:** 2026-11-03 12:11:34 UTC
- **Hash Integritas Terverifikasi:**
  - **Git Blob Hash (Acuan Tunggal Git):** `3ac0deaa8519dc256d261baf5765ed48a06ac217`
  - **Normalized UTF-8 LF SHA-256 (Acuan Konten Lintas OS):** `628fb4e048ecae814bbaa4f8d9214cffc21b7c8474f39514449cc563a95cdc8b`
  - *Raw Binary / Windows CRLF SHA-256 (Informasional lokal):* `45cdcf89b2e56ebf2ad532fc6b28c459cefabe41151e24579daf631f2629ee00`
- **Cakupan Utama:**
  - Gambaran umum produk, problem statement, tujuan, dan non-goals
  - User roles (Administrator dan API Consumer)
  - Core tech stack (Next.js, TypeScript, Tailwind, MongoDB Atlas, Auth.js, Recharts, SSE)
  - Functional requirements dasar (FR-001 s.d. FR-013)
  - Ketentuan fallback provider resmi Gemini API bila Antigravity belum terverifikasi

---

### 2.4 Dokumen Matriks Kasus Uji (Test Matrix)

- **Berkas Repositori:** `docs/contract/test-matrix.md`
- **Tipe Dokumen:** Spesifikasi Matriks Kasus Uji Boundary Requirement 5 & Requirement 6
- **Asal Dokumen:** Bayu (Backend Engineer), revisi TASK-091 merespons temuan audit formal Reza (`docs/contract/review.md`)
- **Versi / Iterasi:** Versi revisi koreksi audit TASK-091
- **Tanggal Pembaruan:** 2026-11-03
- **Status Persetujuan:** Menunggu Audit Ulang Formal Reza (Belum Disetujui / Belum Frozen)
- **Hash Integritas Terverifikasi:**
  - **Git Blob Hash (Acuan Tunggal Git):** `92d53dcaa61fbc2160a7dead76b1eb0b7277e32f`
  - **Normalized UTF-8 LF SHA-256 (Acuan Konten Lintas OS):** `a31144208e2fdb1c49d7ada2d06eef2cbfe70397d2c33f98ad4c78c4cb3ddb7e`
- **Cakupan & Koreksi Audit Terintegrasi (TASK-091):**
  - **Pemisahan Error Provider (Temuan 1):** `TC-REQ5-ERR-05` (respons HTTP 5xx / penolakan upstream -> `502 provider_error`) dipisahkan dari `TC-REQ5-ERR-07` (kegagalan koneksi transport / tidak dapat dihubungi -> `503 provider_unavailable` sesuai Req 4 AC 3), dengan assertion rahasia tidak bocor dan provider tidak dipanggil ulang.
  - **Penyelarasan Retensi 24 Jam (Temuan 2):** Menyelaraskan kasus `TC-REQ6-24H-01` (`terminal_at + 86.399s`, `t < dedupe_until`: retry keputusan lama mengembalikan respons tersimpan dan `outcome`), `TC-REQ6-24H-02` (`terminal_at + 86.400s`, `t = dedupe_until`: admission baru melalui pembandingan atomik terhadap `dedupe_until` saat record TTL belum dihapus Atlas), dan `TC-REQ6-24H-03` (`terminal_at + 86.401s`: admission baru dengan payload berbeda diizinkan tanpa `idempotency_conflict`), sesuai `approved-design.md:206`.
  - **Retry Penolakan Lintas Batas Menit (Temuan 3):** Memperluas pengujian penolakan `rejected` menjadi `TC-REQ6-IDM-04A` (retry rate limit sebelum pergantian menit UTC: `Retry-After` dihitung ulang sampai batas jendela asal), `TC-REQ6-IDM-04B` (retry rate limit setelah pergantian menit UTC: `Retry-After` dihilangkan / omitted), dan `TC-REQ6-IDM-04C` (retry concurrency limit: `Retry-After: 1` konstan), masing-masing mengembalikan status `429`, kode penolakan asli, dan metadata `outcome` tanpa memanggil provider.
  - **Klarifikasi Konflik Idempotensi (Minor Review):** Memisahkan kasus konflik payload `TC-REQ6-IDM-05A` (saat request awal masih aktif / `running` dengan lease aktif sebelum `dedupe_until` ditetapkan) dari `TC-REQ6-IDM-05B` (saat request awal berstatus terminal dalam masa retensi `t < dedupe_until`), serta menegaskan aturan `Retry-After` penolakan secara eksplisit.

---

## 3. Protokol Verifikasi Integritas Lintas Lingkungan

Untuk menjamin konsistensi verifikasi integritas berkas di lingkungan Windows (CRLF), Linux (LF), maupun macOS (LF), pipeline dan penguji diwajibkan menggunakan prosedur verifikasi deterministik berikut:

### Prosedur A: Menggunakan Git Blob Hash (Direkomendasikan di Git Repository)

Perintah ini menghitung SHA-1 objek blob Git persis seperti yang disimpan oleh Git, sehingga menghasilkan nilai identik di semua platform tanpa terpengaruh konfigurasi `core.autocrlf`:

```bash
git hash-object docs/contract/requirements.md docs/contract/approved-design.md docs/PRD.md docs/contract/decision-matrix.md docs/contract/test-matrix.md
```

Ekspektasi output:
```text
49ad505556c00df4515202be6360ef6564d260c8
00c70a3d72490c99281e72333139bf101d296d54
3ac0deaa8519dc256d261baf5765ed48a06ac217
7bb6ba9d5ff8b2876c1317835abea882fc3731b6
92d53dcaa61fbc2160a7dead76b1eb0b7277e32f
```

### Prosedur B: Menggunakan Normalized UTF-8 LF SHA-256 (Node.js Cross-Platform)

Skrip satu baris ini menormalisasi baris akhir (`\r\n` -> `\n`) sebelum menghitung SHA-256:

```bash
node -e "const fs = require('fs'), crypto = require('crypto'); ['docs/contract/requirements.md', 'docs/contract/approved-design.md', 'docs/PRD.md', 'docs/contract/decision-matrix.md', 'docs/contract/test-matrix.md'].forEach(f => { const c = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'); console.log(f, crypto.createHash('sha256').update(c, 'utf8').digest('hex')); });"
```

Ekspektasi output:
```text
docs/contract/requirements.md 480d0d32ce0ddf1ef13008b27b4f11d6b8d0926ed23748260880db625c6d444d
docs/contract/approved-design.md b27b532e2a0128d9a9aa626e5b256260639a95e2c9bcd564cfc944b6f16e21fa
docs/PRD.md 628fb4e048ecae814bbaa4f8d9214cffc21b7c8474f39514449cc563a95cdc8b
docs/contract/decision-matrix.md 9937d64ff560d1570fb7ba9a2e827664477ec2eec80a76717c1cef9c8f6f4c10
docs/contract/test-matrix.md a31144208e2fdb1c49d7ada2d06eef2cbfe70397d2c33f98ad4c78c4cb3ddb7e
```
