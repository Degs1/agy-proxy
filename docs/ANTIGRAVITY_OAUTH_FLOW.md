# Arsitektur & Flow Lengkap Google OAuth Antigravity (Cloud Code)

Dokumen ini mendokumentasikan spesifikasi teknis dan alur kerja (workflow) lengkap dari mekanisme OAuth Google Antigravity seperti yang diimplementasikan pada repositori `dvcrn/antigravity-oauth-proxy`. Dokumen ini dirancang agar dapat dibaca, dipahami, dan diimplementasikan ulang oleh AI Agent maupun pengembang.

---

## 1. Ringkasan Eksekutif

Antigravity OAuth Proxy memungkinkan klien eksternal (Gemini API, OpenAI SDK, atau Model Context Protocol / MCP) menggunakan model AI Google yang tersedia untuk akun **Google Antigravity** (seperti Claude 3.5 Sonnet, Gemini 2.5 Pro, Gemini 2.5 Flash, dll).

Inti dari mekanismenya adalah **Impersonation**:
Aplikasi ini bertindak seolah-olah dirinya adalah klien resmi Google Cloud Code / Antigravity CLI dengan memanfaatkan Client ID dan Client Secret bawaan Google, meminta scope internal Cloud Code, dan membungkus panggilan API ke endpoint internal Google (`cloudcode-pa.googleapis.com`).

```
┌─────────────────┐       ┌────────────────────────┐       ┌───────────────────────┐       ┌───────────────────────────┐
│ User / Browser  │       │  Antigravity Proxy     │       │  Google OAuth Server  │       │ Google Cloud Code API     │
└────────┬────────┘       └───────────┬────────────┘       └───────────┬───────────┘       └─────────────┬─────────────┘
         │                            │                                │                                 │
         │                            │ 1. Generate PKCE & State       │                                 │
         │                            │ 2. Listen :51121               │                                 │
         │ 3. Buka URL Auth di Web    │                                │                                 │
         │ ──────────────────────────▶│                                │                                 │
         │                            │                                │                                 │
         │ 4. Login & Consent Akun Google                              │                                 │
         │ ───────────────────────────────────────────────────────────▶│                                 │
         │                            │                                │                                 │
         │ 5. Redirect ke callback http://localhost:51121/oauth-callback?code=...                        │
         │ ──────────────────────────▶│                                │                                 │
         │                            │                                │                                 │
         │                            │ 6. Exchange Code + PKCE        │                                 │
         │                            │ ──────────────────────────────▶│                                 │
         │                            │                                │                                 │
         │                            │ 7. Return Access & Refresh Tok │                                 │
         │                            │ ◀──────────────────────────────│                                 │
         │                            │                                │                                 │
         │                            │ 8. Simpan ke oauth_creds.json  │                                 │
         │                            │                                │                                 │
         │                            │ 9. Verifikasi via loadCodeAssist (User-Agent Impersonation)      │
         │                            │ ────────────────────────────────────────────────────────────────▶│
         │                            │                                                                  │
         │                            │ 10. Konfirmasi Project ID / Tiers                                │
         │                            │ ◀────────────────────────────────────────────────────────────────│
```

---

## 2. Konstanta & Kredensial OAuth

Client ID dan Client Secret yang digunakan adalah kredensial aplikasi desktop resmi yang sudah terdaftar di Google Cloud Code:

| Properti | Nilai | Keterangan |
|---|---|---|
| **Client ID** | `<ANTIGRAVITY_CLIENT_ID>` | Official Google Cloud Code Client ID (diambil dari env / constants) |
| **Client Secret** | `<ANTIGRAVITY_CLIENT_SECRET>` | Official Google Cloud Code Client Secret (diambil dari env / constants) |
| **Redirect URI** | `http://localhost:51121/oauth-callback` | Port callback lokal |
| **Auth URL** | `https://accounts.google.com/o/oauth2/v2/auth` | Google OAuth Authorization Endpoint |
| **Token URL** | `https://oauth2.googleapis.com/token` | Google OAuth Token Endpoint |
| **UserInfo URL**| `https://www.googleapis.com/oauth2/v1/userinfo?alt=json` | Endpoint informasi profil user |
| **Cloud Code API** | `https://daily-cloudcode-pa.googleapis.com` atau `https://cloudcode-pa.googleapis.com` | Endpoint backend Antigravity internal |

### Scopes yang Diwajibkan:
1. `https://www.googleapis.com/auth/cloud-platform` — Akses platform GCP
2. `https://www.googleapis.com/auth/userinfo.email` — Email akun pengguna
3. `https://www.googleapis.com/auth/userinfo.profile` — Informasi profil
4. `https://www.googleapis.com/auth/cclog` — Logging internal Cloud Code
5. `https://www.googleapis.com/auth/experimentsandconfigs` — Konfigurasi & flag eksperimental Antigravity

---

## 3. Tahap demi Tahap Alur Autentikasi (Step-by-Step Flow)

### Tahap 1: Pembuatan State & PKCE (Proof Key for Code Exchange)
Sebelum membuka browser, buat pasangan token kriptografi untuk mengamankan proses autorisasi:

1. **State:**
   * Ambil 16 byte acak (CSPRNG).
   * Encode ke Base64 URL (tanpa padding).
   * Contoh: `a8F3_k91LmQ...`
2. **PKCE Code Verifier:**
   * Ambil 32 byte acak (CSPRNG).
   * Encode ke Base64 URL (tanpa padding) sebagai `code_verifier`.
3. **PKCE Code Challenge:**
   * Lakukan hashing SHA-256 pada string `code_verifier`.
   * Encode hash biner tersebut ke Base64 URL (tanpa padding).
   * `code_challenge_method = "S256"`.

### Tahap 2: Pembentukan URL Autorisasi
Susun URL query string ke `https://accounts.google.com/o/oauth2/v2/auth` dengan parameter:
```http
https://accounts.google.com/o/oauth2/v2/auth?
  client_id=<ANTIGRAVITY_CLIENT_ID>&
  redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback&
  response_type=code&
  scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.profile+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcclog+https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fexperimentsandconfigs&
  access_type=offline&
  prompt=consent&
  include_granted_scopes=true&
  state=<GENERATED_STATE>&
  code_challenge=<GENERATED_CODE_CHALLENGE>&
  code_challenge_method=S256
```
> **Catatan Penting:** Parameter `access_type=offline` dan `prompt=consent` **wajib** ada agar Google selalu mengembalikan `refresh_token`.

### Tahap 3: Menangkap Authorization Code
Ada dua mode penangkapan kode callback:

#### Mode A: Local Web Server (Default / GUI)
1. Buka browser otomatis (`xdg-open`, `open`, atau `rundll32 url.dll,FileProtocolHandler`).
2. Jalankan HTTP listener di `127.0.0.1:51121`.
3. Ketika user menyetujui, Google mengarahkan browser ke:
   `http://localhost:51121/oauth-callback?code=4/0A...&state=...`
4. Server lokal menangkap parameter `code` dan `state`.
5. Server mengirimkan respons HTML sederhana ke browser ("Authentication successful! You can close this tab.") lalu mematikan server lokal.
6. Lakukan verifikasi bahwa `state` yang diterima sama persis dengan `state` yang dikirim pada Tahap 1 (menggunakan constant-time comparison).

#### Mode B: Manual Stdin (Headless / SSH / Server)
Jika browser tidak dapat dibuka atau mode `--no-browser` diaktifkan:
1. URL otentikasi dicetak di terminal.
2. User membuka URL tersebut di perangkat mana saja.
3. Setelah login, browser user akan gagal me-load `localhost:51121`, tetapi URL pada address bar memuat parameter `?code=...`.
4. User menyalin (paste) URL lengkap atau nilai `code` tersebut ke input terminal.

---

### Tahap 4: Pertukaran Kode Menjadi Token (Token Exchange)
Kirim request HTTP `POST` ke endpoint token Google:

* **Endpoint:** `https://oauth2.googleapis.com/token`
* **Header:** `Content-Type: application/x-www-form-urlencoded`
* **Body:**
  ```http
  client_id=<ANTIGRAVITY_CLIENT_ID>&
  client_secret=<ANTIGRAVITY_CLIENT_SECRET>&
  code=<AUTHORIZATION_CODE>&
  code_verifier=<PKCE_CODE_VERIFIER>&
  grant_type=authorization_code&
  redirect_uri=http://localhost:51121/oauth-callback
  ```

#### Response dari Google (200 OK):
```json
{
  "access_token": "ya29.a0AfH6SM...",
  "expires_in": 3599,
  "refresh_token": "1//04...",
  "scope": "https://www.googleapis.com/auth/cloud-platform ...",
  "token_type": "Bearer",
  "id_token": "eyJhbGciOiJSUzI1NiIs..."
}
```

---

### Tahap 5: Penyimpanan Kredensial Lokal

Data token disimpan ke sistem file lokal:
* **Lokasi Standar:** `~/.config/antigravity-oauth-proxy/oauth_creds.json`
  * Di Windows: `C:\Users\<USER>\.config\antigravity-oauth-proxy\oauth_creds.json`
  * Atau melalui environment variable: `CLOUDCODE_OAUTH_CREDS_PATH`

#### Format File `oauth_creds.json`:
```json
{
  "access_token": "ya29.a0Af...",
  "refresh_token": "1//04...",
  "expiry_date": 1730720400000,
  "token_type": "Bearer",
  "scope": "https://www.googleapis.com/auth/cloud-platform ...",
  "id_token": "eyJhbGci..."
}
```
* Nilai `expiry_date` dihitung sebagai:
  $$\text{expiry\_date} = (\text{CurrentUnixTimeInSeconds} + \text{expires\_in}) \times 1000$$

---

### Tahap 6: Verifikasi & Inisialisasi Antigravity (`loadCodeAssist`)

Setelah mendapatkan kredensial, proxy melakukan validasi bahwa akun memiliki akses Antigravity dengan memanggil endpoint internal Google Cloud Code.

* **Endpoint:** `https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`
* **Method:** `POST`
* **Headers:**
  ```http
  Authorization: Bearer <access_token>
  Content-Type: application/json
  User-Agent: antigravity/cli/1.4.6 (aidev_client; os_type=windows; arch=amd64; cl=964361259; auth_method=consumer)
  ```
* **Body:**
  ```json
  {
    "metadata": {
      "ideType": "ANTIGRAVITY"
    }
  }
  ```

#### Penanganan Respons:
1. **Consumer Project (Default):**
   Jika `gcpManaged == false`, response akan berisi field `cloudaicompanionProject` (misal: `"projects/123456789"` atau nama project). Project ID ini yang akan digunakan untuk request inferensi model.
2. **GCP Managed Project (Onboarding Flow):**
   Jika `gcpManaged == true` dan `cloudaicompanionProject` kosong, proxy akan memicu alur pendaftaran otomatis melalui `onboardUser`:
   * Mengirim `POST` ke `/v1internal:onboardUser` dengan `tierId` (biasanya `"free-tier"`).
   * Melakukan polling ke operasi asynchronous (LRO - Long Running Operation) hingga project selesai disiapkan.

---

### Tahap 7: Siklus Refresh Token Otomatis (Lifecycle Management)

Access token Google hanya berlaku selama 1 jam (`expires_in = 3599`). Proxy mengelola refresh token secara proaktif tanpa interupsi pengguna:

1. **Preemptive Check:**
   Sebelum setiap request API dieksekusi, periksa waktu:
   $$\text{CurrentTime} + 5\text{ menit} \ge \text{expiry\_date}$$
   Jika token akan habis dalam 5 menit, lakukan refresh terlebih dahulu.
2. **Reactive Retry:**
   Jika request ke Cloud Code menghasilkan HTTP `401 Unauthorized`, proxy otomatis memicu refresh token satu kali, memperbarui header, dan mengulang kembali request yang gagal.

#### Payload Request Refresh Token:
* **Endpoint:** `https://oauth2.googleapis.com/token`
* **Method:** `POST`
* **Header:** `Content-Type: application/x-www-form-urlencoded`
* **Body:**
  ```http
  client_id=<ANTIGRAVITY_CLIENT_ID>&
  client_secret=<ANTIGRAVITY_CLIENT_SECRET>&
  grant_type=refresh_token&
  refresh_token=<STORED_REFRESH_TOKEN>
  ```
* Respons baru disimpan kembali ke `oauth_creds.json` secara atomik dengan mutex lock untuk mencegah *race condition* jika ada beberapa request masuk bersamaan.

---

## 4. Format Request Inferensi ke Antigravity (`streamGenerateContent`)

Ketika klien memanggil endpoint proxy (seperti `/v1beta/models/...:streamGenerateContent` atau `/v1/chat/completions`), proxy meneruskannya ke:

* **Endpoint:** `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`
* **Headers Wajib:**
  ```http
  Authorization: Bearer <valid_access_token>
  Content-Type: application/json
  Accept: text/event-stream
  User-Agent: antigravity/cli/1.4.6 (aidev_client; os_type=windows; arch=amd64; cl=964361259; auth_method=consumer)
  ```
* **Struktur Body Penting:**
  ```json
  {
    "project": "<PROJECT_ID_FROM_LOADCODEASSIST>",
    "model": "gemini-2.5-pro",
    "request": {
      "contents": [
        {
          "role": "user",
          "parts": [{ "text": "Halo!" }]
        }
      ],
      "sessionId": "<DERIVED_OR_PERSISTED_SESSION_ID>"
    },
    "userAgent": "antigravity",
    "requestType": "agent",
    "requestId": "antigravity-<UUID>"
  }
  ```

---

## 5. Ringkasan Checklist untuk Agent

Jika agen AI ingin mengimplementasikan atau mengotomasi alur ini:

1. [ ] **Gunakan Kredensial Resmi**: Gunakan Client ID dan Secret bawaan Cloud Code (Section 2).
2. [ ] **Buat PKCE**: Buat `code_verifier` (Base64URL) dan `code_challenge` (SHA256 Base64URL).
3. [ ] **Siapkan Listener**: Jalankan HTTP server di port `51121` pada endpoint `/oauth-callback`.
4. [ ] **Buka Auth URL**: Sertakan scopes `cloud-platform`, `userinfo.email`, `cclog`, dll.
5. [ ] **Tukar Kode**: Post code + code_verifier ke `oauth2.googleapis.com/token`.
6. [ ] **Simpan JSON**: Tulis ke `~/.config/antigravity-oauth-proxy/oauth_creds.json`.
7. [ ] **Inisialisasi Project**: Jalankan `POST /v1internal:loadCodeAssist` dengan header `User-Agent: antigravity/cli/...`.
8. [ ] **Handle Auto-Refresh**: Pastikan fungsi cek expiry (< 5 menit) dan refresh otomatis aktif sebelum melakukan request inferensi.
