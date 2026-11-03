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

> **Status Keterblokiran Kontrak:**  
> Seluruh dokumen sumber telah tersedia dan diarsipkan secara lengkap di repositori kerja dengan integritas hash deterministik yang independen dari format akhir baris (*line ending*). **Kontrak MVP TIDAK TERBLOKIR DARI SISI DOKUMEN SUMBER**, dan saat ini berada pada tahap **Menunggu Review dan Persetujuan Formal (TASK-004)** sebelum implementasi downstream (TASK-007 s.d. TASK-086) dapat dibuka.

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

## 3. Protokol Verifikasi Integritas Lintas Lingkungan

Untuk menjamin konsistensi verifikasi integritas berkas di lingkungan Windows (CRLF), Linux (LF), maupun macOS (LF), pipeline dan penguji diwajibkan menggunakan prosedur verifikasi deterministik berikut:

### Prosedur A: Menggunakan Git Blob Hash (Direkomendasikan di Git Repository)

Perintah ini menghitung SHA-1 objek blob Git persis seperti yang disimpan oleh Git, sehingga menghasilkan nilai identik di semua platform tanpa terpengaruh konfigurasi `core.autocrlf`:

```bash
git hash-object docs/contract/requirements.md docs/contract/approved-design.md docs/PRD.md
```

Ekspektasi output:
```text
49ad505556c00df4515202be6360ef6564d260c8
00c70a3d72490c99281e72333139bf101d296d54
3ac0deaa8519dc256d261baf5765ed48a06ac217
```

### Prosedur B: Menggunakan Normalized UTF-8 LF SHA-256 (Node.js Cross-Platform)

Skrip satu baris ini menormalisasi baris akhir (`\r\n` -> `\n`) sebelum menghitung SHA-256:

```bash
node -e "const fs = require('fs'), crypto = require('crypto'); ['docs/contract/requirements.md', 'docs/contract/approved-design.md', 'docs/PRD.md'].forEach(f => { const c = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'); console.log(f, crypto.createHash('sha256').update(c, 'utf8').digest('hex')); });"
```

Ekspektasi output:
```text
docs/contract/requirements.md 480d0d32ce0ddf1ef13008b27b4f11d6b8d0926ed23748260880db625c6d444d
docs/contract/approved-design.md b27b532e2a0128d9a9aa626e5b256260639a95e2c9bcd564cfc944b6f16e21fa
docs/PRD.md 628fb4e048ecae814bbaa4f8d9214cffc21b7c8474f39514449cc563a95cdc8b
```
