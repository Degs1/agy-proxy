# Matriks Kasus Uji MVP (Test Matrix)

Dokumen ini memetakan kriteria penerimaan (**Acceptance Criteria**) menjadi kasus uji terverifikasi yang mencakup seluruh kondisi **tepat pada batas (on-the-boundary)** dan **di luar batas (off-the-boundary)** untuk **Requirement 5 (Endpoint REST kompatibel OpenAI)** dan **Requirement 6 (Rate Limiting dan Concurrency Terdistribusi)**, sesuai kontrak yang ditetapkan dalam `docs/contract/requirements.md` dan `docs/contract/approved-design.md`.

Arsip dan matriks ini menjadi kontrak resmi yang dipakai validator, implementasi, dan pengujian otomatis.

---

## 1. Matriks Kasus Uji Requirement 5 — Endpoint REST Kompatibel OpenAI

### 1.1 Batas Ukuran Body Request (Payload Size)
- **Rujukan Kontrak:** Requirement 5, AC 1; Approved Design Bagian Desain Sistem & Kontrak REST.
- **Batas Keras:** 1 MiB = 1.048.576 byte UTF-8.

| ID Kasus Uji | AC Ref | Kategori Batas | Kondisi Input / Payload | Ekspektasi HTTP Status | Ekspektasi Kode Error | Ekspektasi Field `param` | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|---|
| `TC-REQ5-BODY-01` | Req 5, AC 1 | **Tepat pada batas (On-boundary max)** | Ukuran body JSON tepat 1.048.576 byte (1 MiB) | `200 OK` (atau skema valid) | `null` | `null` | Body terbaca utuh dan diteruskan ke validasi skema. Jika lolos admission, provider dipanggil. |
| `TC-REQ5-BODY-02` | Req 5, AC 1 | **Di luar batas atas (Off-boundary +1)** | Ukuran body JSON 1.048.577 byte (1 MiB + 1 byte) | `413 Payload Too Large` | `payload_too_large` | `null` | Pembacaan stream langsung diputus saat byte ke-1.048.577 terdeteksi. **Assertion: Upstream provider TIDAK dipanggil; slot concurrency tidak diambil; kuota rate tidak berkurang.** |
| `TC-REQ5-BODY-03` | Req 5, AC 1 | **Di luar batas bawah (Off-boundary 0)** | Body kosong (0 byte) dengan header Content-Type application/json | `400 Bad Request` | `invalid_request` | `null` | Ditolak karena body tidak memuat payload JSON valid. **Assertion: Upstream provider TIDAK dipanggil.** |

---

### 1.2 Batas Panjang Array Messages
- **Rujukan Kontrak:** Requirement 5, AC 1; Approved Design Bagian Kontrak REST.
- **Batas Keras:** 1 sampai 64 item pesan.

| ID Kasus Uji | AC Ref | Kategori Batas | Kondisi Input / Payload | Ekspektasi HTTP Status | Ekspektasi Kode Error | Ekspektasi Field `param` | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|---|
| `TC-REQ5-MSG-LEN-01` | Req 5, AC 1 | **Di luar batas bawah (Off-boundary 0)** | Array `messages: []` (0 item) | `400 Bad Request` | `invalid_request` | `"messages"` | Ditolak karena jumlah pesan kurang dari 1. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-MSG-LEN-02` | Req 5, AC 1 | **Tepat pada batas bawah (On-boundary min)** | Array `messages` berisi tepat 1 item (peran `user`) | `200 OK` (atau lolos ke limiter) | `null` | `null` | Diterima sebagai percakapan minimal yang sah; lanjut ke transaksi admission. |
| `TC-REQ5-MSG-LEN-03` | Req 5, AC 1 | **Tepat pada batas atas (On-boundary max)** | Array `messages` berisi tepat 64 item dengan urutan peran sah | `200 OK` (atau lolos ke limiter) | `null` | `null` | Diterima sebagai percakapan kapasitas penuh yang sah; lanjut ke transaksi admission. |
| `TC-REQ5-MSG-LEN-04` | Req 5, AC 1 | **Di luar batas atas (Off-boundary +1)** | Array `messages` berisi 65 item | `400 Bad Request` | `invalid_request` | `"messages"` | Ditolak karena jumlah pesan melebihi batas 64 item. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-MSG-LEN-05` | Req 5, AC 1 | **Di luar batas tipe (Invalid Type)** | Field `messages` berupa string atau object | `400 Bad Request` | `invalid_request` | `"messages"` | Ditolak karena skema mengharuskan array. **Assertion: Provider TIDAK dipanggil.** |

---

### 1.3 Batas Ukuran Konten Pesan (Content Size)
- **Rujukan Kontrak:** Requirement 5, AC 1; Approved Design Bagian Kontrak REST.
- **Batas Keras:** 1 sampai 32.768 byte UTF-8 per item pesan.

| ID Kasus Uji | AC Ref | Kategori Batas | Kondisi Input / Payload | Ekspektasi HTTP Status | Ekspektasi Kode Error | Ekspektasi Field `param` | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|---|
| `TC-REQ5-CNT-LEN-01` | Req 5, AC 1 | **Di luar batas bawah (Off-boundary 0)** | Konten pesan string kosong `""` pada `messages[0]` | `400 Bad Request` | `invalid_request` | `"messages[0].content"` | Ditolak karena string konten tidak boleh kosong. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-CNT-LEN-02` | Req 5, AC 1 | **Tepat pada batas bawah (On-boundary min)** | Konten pesan sepanjang 1 byte UTF-8 (contoh: `"A"`) | `200 OK` (atau lolos) | `null` | `null` | Diterima sebagai konten minimal yang sah. |
| `TC-REQ5-CNT-LEN-03` | Req 5, AC 1 | **Tepat pada batas atas (On-boundary max)** | Konten pesan sepanjang tepat 32.768 byte UTF-8 ASCII/karakter | `200 OK` (atau lolos) | `null` | `null` | Diterima sebagai konten ukuran maksimum yang sah. |
| `TC-REQ5-CNT-LEN-04` | Req 5, AC 1 | **Di luar batas atas (Off-boundary +1)** | Konten pesan sepanjang 32.769 byte UTF-8 | `400 Bad Request` | `invalid_request` | `"messages[i].content"` | Ditolak karena melampaui 32 KiB UTF-8. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-CNT-LEN-05` | Req 5, AC 1 | **Batas multi-byte UTF-8** | String dengan 8.192 karakter emoji 4-byte (total 32.768 byte) | `200 OK` (atau lolos) | `null` | `null` | Validasi menghitung byte UTF-8 aktual, bukan panjang karakter JS string `.length`. |
| `TC-REQ5-CNT-LEN-06` | Req 5, AC 1 | **Di luar batas multi-byte** | String dengan 8.193 karakter emoji 4-byte (total 32.772 byte) | `400 Bad Request` | `invalid_request` | `"messages[i].content"` | Ditolak karena ukuran byte UTF-8 melebihi 32.768 byte. **Assertion: Provider TIDAK dipanggil.** |

---

### 1.4 Batas Peran dan Pola Urutan Pesan (Roles & Sequence)
- **Rujukan Kontrak:** Requirement 5, AC 1; Approved Design Bagian Kontrak REST.
- **Aturan Urutan:** Nol atau lebih `system` di awal -> `user` pertama -> `assistant` dan `user` bergantian -> diakhiri `user`.

| ID Kasus Uji | AC Ref | Kategori Batas | Kondisi Input / Payload | Ekspektasi HTTP Status | Ekspektasi Kode Error | Ekspektasi Field `param` | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|---|
| `TC-REQ5-SEQ-01` | Req 5, AC 1 | **Tepat pada batas (Minimal valid)** | `[user]` | `200 OK` | `null` | `null` | Pola minimal yang sah. Lanjut ke admission. |
| `TC-REQ5-SEQ-02` | Req 5, AC 1 | **Tepat pada batas (Multi-system awal)** | `[system, system, user]` | `200 OK` | `null` | `null` | Beberapa system di awal sah dan dipertahankan sesuai urutan aslinya. |
| `TC-REQ5-SEQ-03` | Req 5, AC 1 | **Tepat pada batas (Percakapan panjang)** | `[system, user, assistant, user, assistant, user]` | `200 OK` | `null` | `null` | Pola pergantian peran sempurna berakhiran user. |
| `TC-REQ5-SEQ-04` | Req 5, AC 1 | **Di luar batas (Awal bukan user/sys)** | `[assistant, user]` | `400 Bad Request` | `invalid_request` | `"messages[0].role"` | Percakapan tidak boleh dimulai dengan assistant. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-SEQ-05` | Req 5, AC 1 | **Di luar batas (Akhir bukan user)** | `[user, assistant]` | `400 Bad Request` | `invalid_request` | `"messages[1].role"` | Percakapan tidak boleh diakhiri dengan assistant. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-SEQ-06` | Req 5, AC 1 | **Di luar batas (Hanya system)** | `[system, system]` tanpa user | `400 Bad Request` | `invalid_request` | `"messages"` | Percakapan wajib memuat sedikitnya satu pesan user. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-SEQ-07` | Req 5, AC 1 | **Di luar batas (System terlambat)** | `[user, system, user]` | `400 Bad Request` | `invalid_request` | `"messages[1].role"` | Pesan system tidak boleh muncul setelah percakapan dimulai. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-SEQ-08` | Req 5, AC 1 | **Di luar batas (User berturut-turut)** | `[user, user]` | `400 Bad Request` | `invalid_request` | `"messages[1].role"` | User berturut-turut melanggar pola pergantian peran. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-SEQ-09` | Req 5, AC 1 | **Di luar batas (Assistant berturut)** | `[user, assistant, assistant, user]` | `400 Bad Request` | `invalid_request` | `"messages[2].role"` | Assistant berturut-turut melanggar pola pergantian peran. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-SEQ-10` | Req 5, AC 1 | **Di luar batas (Peran tidak sah)** | `messages[0].role: "tool"` atau `"developer"` | `400 Bad Request` | `invalid_request` | `"messages[0].role"` | Peran di luar system/user/assistant ditolak tegas. **Assertion: Provider TIDAK dipanggil.** |

---

### 1.5 Batas Parameter Numerik dan Opsional
- **Rujukan Kontrak:** Requirement 5, AC 1; Approved Design Bagian Kontrak REST.

| ID Kasus Uji | AC Ref | Parameter | Nilai Uji / Kasus | Ekspektasi HTTP Status | Ekspektasi Kode Error | Ekspektasi Field `param` | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|---|
| `TC-REQ5-NUM-TMP-01` | Req 5, AC 1 | `temperature` | `0` atau `0.0` (Batas bawah inklusif) | `200 OK` | `null` | `null` | Nilai batas bawah sah; dipetakan ke Gemini `generationConfig.temperature: 0`. |
| `TC-REQ5-NUM-TMP-02` | Req 5, AC 1 | `temperature` | `-0.001` (Di luar batas bawah) | `400 Bad Request` | `invalid_request` | `"temperature"` | Ditolak karena di bawah 0. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-NUM-TMP-03` | Req 5, AC 1 | `temperature` | `2` atau `2.0` (Batas atas inklusif) | `200 OK` | `null` | `null` | Nilai batas atas sah; dipetakan ke Gemini `generationConfig.temperature: 2.0`. |
| `TC-REQ5-NUM-TMP-04` | Req 5, AC 1 | `temperature` | `2.001` (Di luar batas atas) | `400 Bad Request` | `invalid_request` | `"temperature"` | Ditolak karena di atas 2. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-NUM-TMP-05` | Req 5, AC 1 | `temperature` | Dihilangkan (omitted) | `200 OK` | `null` | `null` | Diterima; tidak dikirim ke generationConfig (mengikuti default provider). |
| `TC-REQ5-NUM-TOK-01` | Req 5, AC 1 | `max_tokens` | `1` (Batas bawah inklusif) | `200 OK` | `null` | `null` | Nilai token minimum sah; dipetakan ke `generationConfig.maxOutputTokens: 1`. |
| `TC-REQ5-NUM-TOK-02` | Req 5, AC 1 | `max_tokens` | `0` (Di luar batas bawah) | `400 Bad Request` | `invalid_request` | `"max_tokens"` | Ditolak karena minimal 1 token. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-NUM-TOK-03` | Req 5, AC 1 | `max_tokens` | `8192` (Batas atas inklusif) | `200 OK` | `null` | `null` | Nilai token maksimum sah; dipetakan ke `maxOutputTokens: 8192`. |
| `TC-REQ5-NUM-TOK-04` | Req 5, AC 1 | `max_tokens` | `8193` (Di luar batas atas) | `400 Bad Request` | `invalid_request` | `"max_tokens"` | Ditolak karena melebihi 8192. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-NUM-TOK-05` | Req 5, AC 1 | `max_tokens` | `100.5` (Bukan integer) | `400 Bad Request` | `invalid_request` | `"max_tokens"` | Ditolak karena wajib bilangan bulat. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-NUM-STR-01` | Req 5, AC 1 | `stream` | `false` | `200 OK` | `null` | `null` | Non-streaming JSON response format (`chat.completion`). |
| `TC-REQ5-NUM-STR-02` | Req 5, AC 1 | `stream` | `true` | `200 OK` | `null` | `null` | Streaming SSE response (`text/event-stream`, `chat.completion.chunk`). |
| `TC-REQ5-NUM-STR-03` | Req 5, AC 1 | `stream` | Dihilangkan (omitted) | `200 OK` | `null` | `null` | Dianggap dan dinormalisasi menjadi `false`. |
| `TC-REQ5-NUM-STR-04` | Req 5, AC 1 | `stream` | `"true"` atau `1` (Bukan boolean) | `400 Bad Request` | `invalid_request` | `"stream"` | Ditolak karena tipe harus boolean murni. **Assertion: Provider TIDAK dipanggil.** |

---

### 1.6 Batas Idempotency-Key Header
- **Rujukan Kontrak:** Requirement 5, AC 1; Requirement 6, AC 4; Approved Design.
- **Batas Keras:** Wajib berupa string UUID format baku RFC 4122.

| ID Kasus Uji | AC Ref | Kategori Batas | Nilai Header `Idempotency-Key` | Ekspektasi HTTP Status | Ekspektasi Kode Error | Ekspektasi Field `param` | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|---|
| `TC-REQ5-IDEM-01` | Req 5, AC 1 | **Tepat pada batas format** | `a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d` (UUID v4 valid) | `200 OK` | `null` | `null` | Format UUID diterima sebagai kunci idempotensi yang sah; lanjut ke transaksi limiter. |
| `TC-REQ5-IDEM-02` | Req 5, AC 1 | **Di luar batas (Format non-UUID)** | `request-number-12345` atau string sembarang | `400 Bad Request` | `invalid_request` | `"Idempotency-Key"` | Ditolak karena bukan format UUID baku RFC 4122. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-IDEM-03` | Req 5, AC 1 | **Di luar batas (Header hilang)** | Header `Idempotency-Key` tidak disertakan | `400 Bad Request` | `invalid_request` | `"Idempotency-Key"` | Ditolak karena `Idempotency-Key` wajib disertakan pada MVP. **Assertion: Provider TIDAK dipanggil.** |

---

### 1.7 Penolakan Field di Luar Cakupan (Strict Schema Rejection)
- **Rujukan Kontrak:** Requirement 5, AC 1 & AC 4; Approved Design Bagian Kontrak REST.
- **Aturan:** Hanya 5 field tingkat atas yang diterima (`model`, `messages`, `stream`, `temperature`, `max_tokens`). Tidak ada toleransi field asing yang diabaikan diam-diam.

| ID Kasus Uji | AC Ref | Field Tidak Didukung | Posisi Field | Ekspektasi HTTP Status | Ekspektasi Kode Error | Ekspektasi Field `param` | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|---|
| `TC-REQ5-EXT-01` | Req 5, AC 4 | `tools` | Tingkat atas | `400 Bad Request` | `unsupported_feature` | `"tools"` | Fitur tools OpenAI di luar cakupan MVP ditolak tegas. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-EXT-02` | Req 5, AC 4 | `functions` | Tingkat atas | `400 Bad Request` | `unsupported_feature` | `"functions"` | Fitur functions di luar cakupan MVP ditolak tegas. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-EXT-03` | Req 5, AC 4 | `n` (meski `n: 1`) | Tingkat atas | `400 Bad Request` | `unsupported_feature` | `"n"` | Parameter `n` ditolak tegas meskipun bernilai 1. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-EXT-04` | Req 5, AC 4 | `response_format` | Tingkat atas | `400 Bad Request` | `unsupported_feature` | `"response_format"` | Fitur response_format ditolak tegas. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-EXT-05` | Req 5, AC 4 | Field asing sembarang (`unknown_prop`) | Tingkat atas | `400 Bad Request` | `invalid_request` | `"unknown_prop"` | Field tak dikenal menghasilkan invalid_request. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-EXT-06` | Req 5, AC 4 | Field asing dalam item pesan (`name`, `id`) | Di dalam `messages[i]` | `400 Bad Request` | `invalid_request` | `"messages[i].name"` | Item pesan hanya boleh memuat role dan content. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-EXT-07` | Req 5, AC 4 | Input multimodal (`image_url` pada content) | Di dalam `messages[i]` | `400 Bad Request` | `unsupported_feature` | `"messages[i].content"` | Multimodal di luar MVP ditolak sebagai unsupported_feature. **Assertion: Provider TIDAK dipanggil.** |

---

### 1.8 Batas Autentikasi API Key dan Model Allowlist
- **Rujukan Kontrak:** Requirement 1, AC 3; Requirement 3, AC 3; Requirement 5, AC 3.

| ID Kasus Uji | AC Ref | Skenario Uji | Kondisi Input | Ekspektasi HTTP Status | Ekspektasi Kode Error | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|
| `TC-REQ5-AUTH-01` | Req 5, AC 3 | Header Auth hilang | Tidak ada header `Authorization` | `401 Unauthorized` | `invalid_api_key` | Ditolak sebelum membaca database. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-AUTH-02` | Req 5, AC 3 | Format bukan Bearer | `Authorization: Basic dXNlcjpwYXNz` | `401 Unauthorized` | `invalid_api_key` | Format skema auth wajib Bearer. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-AUTH-03` | Req 5, AC 3 | Key Hash tidak ditemukan | Key acak yang tidak terdaftar di Atlas | `401 Unauthorized` | `invalid_api_key` | Ditolak setelah pencarian hash SHA-256 satu arah di Atlas. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-AUTH-04` | Req 1, AC 3 | Key telah dicabut | Key terdaftar dengan status `revoked` | `401 Unauthorized` | `invalid_api_key` | Key dicabut tidak dapat digunakan kembali. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-AUTH-05` | Req 5, AC 1 | Model alias valid | `model: "gemini-default"` terdaftar dan aktif | `200 OK` (atau lanjut) | `null` | Diterima dan diteruskan ke resolver. Provider dipanggil jika admission commit. |
| `TC-REQ5-AUTH-06` | Req 5, AC 3 | Model alias tidak terdaftar | `model: "gpt-4"` atau model milik project lain | `404 Not Found` | `model_not_found` | Tidak membocorkan model milik project lain. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-AUTH-07` | Req 1, AC 3 | Project nonaktif | Key valid tetapi project berstatus `disabled` | `403 Forbidden` | `project_disabled` | Project nonaktif memblokir seluruh request. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-AUTH-08` | Req 1, AC 3 | Model alias nonaktif | Key & project aktif, tetapi alias berstatus `disabled` | `403 Forbidden` | `model_disabled` | Alias nonaktif memblokir request. **Assertion: Provider TIDAK dipanggil.** |

---

### 1.9 Bentuk Respons Sukses Nonstream (`POST /v1/chat/completions`)
- **Rujukan Kontrak:** Requirement 5, AC 2 & AC 5; Approved Design lines 145-155.

| ID Kasus Uji | AC Ref | Skenario Uji | Kondisi Input & Respons Provider | Ekspektasi HTTP Status | Ekspektasi Struktur Respons JSON | Assertion Perilaku Gateway |
|---|---|---|---|---|---|---|
| `TC-REQ5-RES-01` | Req 5, AC 2 | Respons sukses standar (finish STOP) | Request valid `stream: false`, Gemini menghasilkan teks `"Halo dunia"` dan finishReason `STOP`, usage: prompt 10, completion 5, total 15 | `200 OK` (`application/json`) | `{"id":"chatcmpl-...","object":"chat.completion","created":<unix_sec>,"model":"gemini-default","choices":[{"index":0,"message":{"role":"assistant","content":"Halo dunia"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}` | Alasan `STOP` dipetakan ke `stop`; status admission diupdate ke `succeeded`; lease dilepas; token dihitung dari data terukur. |
| `TC-REQ5-RES-02` | Req 5, AC 2, 5 | Selesai batas panjang (finish MAX_TOKENS) | Gemini menghasilkan teks terpotong dan finishReason `MAX_TOKENS` | `200 OK` (`application/json`) | Struktur identik dengan AC 2, `choices[0].finish_reason: "length"` | Alasan `MAX_TOKENS` dipetakan ke `length`; status `succeeded`; lease dilepas. |
| `TC-REQ5-RES-03` | Req 5, AC 2; Desain | Penggabungan multi-parts teks | Kandidat indeks 0 memuat `content.parts: [{"text":"Halo "},{"text":"dunia!"}]` | `200 OK` (`application/json`) | `choices[0].message.content: "Halo dunia!"` | Teks dari seluruh parts bertipe string digabungkan secara utuh tanpa pemisah tambahan. |
| `TC-REQ5-RES-04` | Req 5, AC 2; Desain | Multi-kandidat dari provider | Provider mengembalikan 2 kandidat (`candidates[0]` dan `candidates[1]`) | `200 OK` (`application/json`) | Tepat satu pilihan di `choices` (`index: 0`) dari kandidat indeks 0 | Hanya kandidat indeks 0 yang digunakan; kandidat 1 dibuang tanpa digabungkan atau mengubah hasil kandidat 0. |
| `TC-REQ5-RES-05` | Req 5, AC 2 | Usage tidak tersedia dari provider | Provider menyelesaikan tanpa metadata usage terukur | `200 OK` (`application/json`) | Field `usage: null` | Gateway tidak mengarang angka token palsu; `usage` disetel `null`. |

---

### 1.10 Pemetaan Error Provider ke Kontrak REST Publik
- **Rujukan Kontrak:** Requirement 4, AC 3; Requirement 5, AC 5; Approved Design lines 147-152, 240-242.
- **Aturan:** Semua kegagalan provider dipetakan ke format error aman OpenAI `{ "error": { "message", "type", "param": null, "code" } }`. Tidak ada kebocoran credential provider. Upstream HTTP 5xx dan penolakan dipetakan ke `502 provider_error`, sedangkan kegagalan koneksi/transport tak dapat dijangkau dipetakan ke `503 provider_unavailable` sesuai Req 4 AC 3.

| ID Kasus Uji | AC Ref | Skenario Error Provider | Kejadian pada Upstream Provider | Ekspektasi HTTP Status | Ekspektasi Kode Error | Ekspektasi Pesan Error Aman | Assertion Perilaku & State |
|---|---|---|---|---|---|---|---|
| `TC-REQ5-ERR-01` | Req 5, AC 5 | Provider Output Blocked (Safety/Policy) | Gemini mengembalikan `promptFeedback` blokir atau candidate `finishReason: "SAFETY"` / `"BLOCKLIST"` | `502 Bad Gateway` | `provider_output_blocked` | `"Provider output blocked due to safety or policy."` | Teks parsial tidak dilaporkan sukses; status terminal `failed`; lease dilepas. Credential tidak bocor. |
| `TC-REQ5-ERR-02` | Req 5, AC 5 | Provider Empty Response | Provider mengembalikan `candidates: []` tanpa blokir, atau parts teks kosong `""` | `502 Bad Gateway` | `provider_empty_response` | `"Provider returned empty response."` | Respons kosong ditolak sebagai error; status terminal `failed`; lease dilepas. |
| `TC-REQ5-ERR-03` | Req 5, AC 5 | Keluaran non-teks provider | Provider mengembalikan hanya part non-teks (misal inline image / function call) tanpa teks | `502 Bad Gateway` | `provider_error` | `"Provider returned unhandled non-text output."` | Keluaran non-teks tidak diubah menjadi teks sembarang; status terminal `failed`. |
| `TC-REQ5-ERR-04` | Req 5, AC 5 | Alasan selesai tak dikenal / bertentangan | `finishReason: "OTHER"`, tak dikenal, atau hilang pada respons final | `502 Bad Gateway` | `provider_error` | `"Provider error occurred."` | Alasan tak dikenal dianggap gagal; status terminal `failed`; lease dilepas. |
| `TC-REQ5-ERR-05` | Req 4, AC 3; Req 5, AC 5 | Upstream HTTP 5xx / Penolakan Provider | Upstream Gemini mengembalikan respons status HTTP 5xx (misal HTTP 500, 502, 503, 504) atau menolak request secara HTTP | `502 Bad Gateway` | `provider_error` | `"Provider failed to process request."` | Respons penolakan/kegagalan upstream dibungkus aman tanpa membocorkan endpoint upstream, model aktual, atau API key/credential. **Assertion: Upstream provider TIDAK dipanggil ulang; status terminal `failed`; slot concurrency dilepas.** |
| `TC-REQ5-ERR-06` | Req 7, AC 3 | Timeout request nonstream (> 120 detik) | Eksekusi provider nonstream melampaui 120 detik | `504 Gateway Timeout` | `gateway_timeout` | `"Gateway timed out waiting for provider."` | Upstream dibatalkan via AbortSignal; status terminal `failed`; lease dilepas. |
| `TC-REQ5-ERR-07` | Req 4, AC 3 | Provider Tidak Dapat Dihubungi (Koneksi / Jaringan) | Kegagalan koneksi transport ke upstream Gemini (socket putus sebelum respons selesai, DNS/ENOTFOUND gagal, ECONNREFUSED, SSL handshake timeout/fail) | `503 Service Unavailable` | `provider_unavailable` | `"Provider is unreachable."` | Kegagalan koneksi dibungkus aman tanpa membocorkan endpoint upstream atau API key/credential. **Assertion: Upstream provider TIDAK dipanggil ulang; status terminal `failed`; slot concurrency dilepas.** |

---

### 1.11 Kontrak Endpoint Model List (`GET /v1/models`)
- **Rujukan Kontrak:** Requirement 5, AC 1, AC 3; PRD FR-008 & Bagian 5.2.
- **Aturan:** Menampilkan daftar alias model yang diizinkan untuk project pemilik API key.

| ID Kasus Uji | AC Ref | Skenario Uji | Kondisi Input | Ekspektasi HTTP Status | Ekspektasi Format Body JSON | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|
| `TC-REQ5-MOD-01` | Req 5, AC 1; PRD | Daftar model project valid | `GET /v1/models` dengan bearer key sah; project memiliki alias aktif `gemini-default` | `200 OK` (`application/json`) | `{"object":"list","data":[{"id":"gemini-default","object":"model","created":1793664000,"owned_by":"project"}]}` | Mengembalikan daftar model yang diizinkan untuk project tersebut. **Assertion: Upstream provider TIDAK dipanggil.** |
| `TC-REQ5-MOD-02` | Req 5, AC 3; PRD | Isolasi model multi-tenant | Project A memiliki `gemini-default`; Project B memiliki `gemini-custom`. Request menggunakan API key Project A | `200 OK` | `data` hanya memuat `gemini-default`. Model milik Project B tidak ada | Isolasi tegas multi-tenant; tidak membocorkan model atau keberadaan konfigurasi project lain. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-MOD-03` | Req 1, AC 3; PRD | Filter alias nonaktif | Project memiliki alias `gemini-inactive` dengan status `disabled` | `200 OK` | `gemini-inactive` tidak dimuat di dalam array `data` | Alias nonaktif tidak disajikan kepada klien API consumer. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-MOD-04` | Req 5, AC 3 | Header Auth hilang / salah | `GET /v1/models` tanpa header `Authorization` atau key salah | `401 Unauthorized` | `{"error":{"message":"Missing or invalid API key.","type":"authentication_error","param":null,"code":"invalid_api_key"}}` | Ditolak pada tahap autentikasi. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ5-MOD-05` | Req 1, AC 3 | Project nonaktif pada `GET /v1/models` | Key valid tetapi project berstatus `disabled` | `403 Forbidden` | `{"error":{"message":"Project is disabled.","type":"permission_error","param":null,"code":"project_disabled"}}` | Akses project nonaktif ditolak tegas. **Assertion: Provider TIDAK dipanggil.** |

---

## 2. Matriks Kasus Uji Requirement 6 — Rate Limiting dan Concurrency Terdistribusi

### 2.1 Batas Rate Limiting Fixed Window 1 Menit UTC (Default 60 RPM)
- **Rujukan Kontrak:** Requirement 6, AC 1 & AC 2; Approved Design.
- **Batas Keras:** Maksimal 60 request diterima per project per jendela menit UTC (`:00` s.d. `:59.999`).

| ID Kasus Uji | AC Ref | Kategori Batas | Waktu Uji (Server Atlas) | Akumulasi Request | Ekspektasi HTTP Status | Ekspektasi Kode / Header | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|---|
| `TC-REQ6-RPM-01` | Req 6, AC 1 | **Tepat pada batas awal jendela** | `2026-11-03T12:00:00.000Z` | Request ke-1 dalam jendela baru | `200 OK` | `count: 1` di Atlas | Jendela dimulai tepat di detik 00; kuota terhitung 1/60; admission diterima. |
| `TC-REQ6-RPM-02` | Req 6, AC 1 | **Tepat pada batas kuota (Max)** | `2026-11-03T12:00:45.000Z` | Request ke-60 dalam jendela yang sama | `200 OK` | `count: 60` di Atlas | Request ke-60 adalah batas kuota terakhir yang diterima dalam jendela tersebut. |
| `TC-REQ6-RPM-03` | Req 6, AC 2 | **Di luar batas kuota (Max + 1)** | `2026-11-03T12:00:45.100Z` | Request ke-61 dalam jendela yang sama | `429 Too Many Requests` | `rate_limit_exceeded`, `Retry-After: 15` | Ditolak sebelum memanggil provider; Retry-After = 60 - 45 = 15 detik. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ6-RPM-04` | Req 6, AC 2 | **Tepat pada batas akhir jendela** | `2026-11-03T12:00:59.999Z` | Request ke-61 dalam jendela yang sama | `429 Too Many Requests` | `rate_limit_exceeded`, `Retry-After: 1` | Ditolak; sisa waktu menuju jendela berikutnya dibulatkan minimal 1 detik. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ6-RPM-05` | Req 6, AC 1 | **Batas pergantian jendela baru** | `2026-11-03T12:01:00.000Z` | Request ke-1 di menit baru | `200 OK` | `count: 1` di Atlas | Kuota direset penuh pada detik 00 menit berikutnya; request diterima. |
| `TC-REQ6-RPM-06` | Req 6, AC 2 | **Konflik ganda (RPM & Concurrency)** | Saat kuota 60/60 dan slot 5/5 penuh serentak | Request baru masuk | `429 Too Many Requests` | `rate_limit_exceeded` | Sesuai kontrak, jika kedua limit penuh, `rate_limit_exceeded` dipilih secara konsisten. **Assertion: Provider TIDAK dipanggil.** |

---

### 2.2 Batas Concurrency Slot (Default 5 Concurrent Requests)
- **Rujukan Kontrak:** Requirement 6, AC 1 & AC 2; Approved Design.
- **Batas Keras:** Maksimal 5 slot aktif (`expires_at > server_time`) per project serentak.

| ID Kasus Uji | AC Ref | Kategori Batas | Slot Aktif Saat Request Masuk | Ekspektasi HTTP Status | Ekspektasi Kode / Header | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|
| `TC-REQ6-CNC-01` | Req 6, AC 1 | **Tepat pada batas slot (Slot 5/5)** | 4 slot aktif sedang berjalan | `200 OK` | Slot terisi menjadi 5/5, lease dibuat | Slot kelima diambil secara sah melalui transaksi Atlas. Provider dipanggil. |
| `TC-REQ6-CNC-02` | Req 6, AC 2 | **Di luar batas slot (Slot ke-6)** | 5 slot aktif sedang berjalan (`expires_at > server_time`) | `429 Too Many Requests` | `concurrency_limit_exceeded`, `Retry-After: 1` | Ditolak sebelum memanggil provider; Retry-After konstan bernilai 1 detik. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ6-CNC-03` | Req 6, AC 1, 3 | **Pelepasan slot tepat waktu** | 1 dari 5 request selesai dan melepas lease | `200 OK` | Slot aktif menjadi 4/5, request ke-6 berhasil masuk | Kapasitas pulih seketika saat lease dilepas via transaksi atomik. |

---

### 2.3 Batas Waktu Lease & Pemulihan Kedaluwarsa (45 Detik & 15 Detik Heartbeat)
- **Rujukan Kontrak:** Requirement 6, AC 1, 3; Approved Design lines 157-164.
- **Aturan:** Masa berlaku lease 45 detik. Heartbeat perpanjangan tiap 15 detik. Kedaluwarsa tepat pada `expires_at <= server_time`. Pemulihan terjadi pada admission pertama **setelah** `expires_at` tanpa menunggu TTL Atlas.

| ID Kasus Uji | AC Ref | Kategori Batas | Titik Waktu Relatif Transaksi | State Lease | Ekspektasi Perilaku Sistem |
|---|---|---|---|---|---|
| `TC-REQ6-LSE-01` | Req 6, AC 1 | **Tepat pada batas aktif** | Detik `T + 44.999s` (`server_time < expires_at`) | Sah (Active) | Lease masih terhitung aktif dalam penghitungan kapasitas concurrency project. |
| `TC-REQ6-LSE-02` | Req 6, AC 1, 3 | **Tepat pada batas kedaluwarsa** | Detik `T + 45.000s` (`server_time == expires_at`) | Kedaluwarsa | Lease dianggap kedaluwarsa seketika; tidak dapat diperpanjang lagi oleh pemegang lease. |
| `TC-REQ6-LSE-03` | Req 6, AC 3 | **Di luar batas kedaluwarsa** | Detik `T + 45.001s` (`server_time > expires_at`) | Kedaluwarsa | Request admission berikutnya menyapu lease ini menjadi `lease_expired` dan membebaskan slot tanpa menunggu background TTL MongoDB Atlas. |
| `TC-REQ6-LSE-04` | Req 6, AC 3 | **Heartbeat perpanjangan sah** | Detik `T + 15.000s` diajukan transaksi perpanjangan | Diperpanjang | Transaksi memverifikasi `expires_at > server_time`, memperbarui `expires_at` menjadi `server_time + 45s`. |
| `TC-REQ6-LSE-05` | Req 6, AC 3; Req 7 | **Heartbeat terlambat / gagal** | Jaringan terputus, heartbeat gagal melampaui detik 45 | Dibatalkan | Gateway segera menghentikan pengiriman stream, membatalkan upstream request via AbortSignal, dan melepas slot. |

---

### 2.4 Batas Idempotensi, Sidik Request, dan Metadata Outcome
- **Rujukan Kontrak:** Requirement 6, AC 4; Approved Design.
- **Kombinasi Kunci:** `(project_id, api_key_id, Idempotency-Key)`.
- **Aturan Retry Penolakan:** Mengacu pada penegakan kasus terpisah `TC-REQ6-IDM-04A`–`04C`. Header `Retry-After` pada pengulangan penolakan tidak dihitung ulang secara umum terhadap jendela aktif saat retry (yang dapat keliru mengirim header untuk menit baru). Untuk penolakan rate limit, header hanya dihitung ulang terhadap sisa durasi jendela penolakan asal (`TC-REQ6-IDM-04A`) dan wajib dihilangkan (`omitted`) setelah jendela penolakan asal berakhir (`TC-REQ6-IDM-04B`). Untuk penolakan concurrency, header selalu bernilai tetap `Retry-After: 1` (`TC-REQ6-IDM-04C`).

| ID Kasus Uji | AC Ref | Skenario Idempotensi | Kondisi Pengulangan (Retry) | Ekspektasi HTTP Status | Ekspektasi Kode Error & Body Response | Assertion Perilaku & Panggilan Provider |
|---|---|---|---|---|---|---|
| `TC-REQ6-IDM-01` | Req 6, AC 4 | **Retry saat request masih aktif** | UUID sama + payload identik saat status masih `running` dengan lease sah | `409 Conflict` | `{"error":{"message":"Request is currently in progress.","type":"requests","param":null,"code":"request_in_progress"}}` | Mencegah panggilan provider ganda. **Assertion: Provider TIDAK dipanggil ulang; kuota rate tidak dinaikkan.** |
| `TC-REQ6-IDM-02` | Req 6, AC 4 | **Retry setelah selesai sukses** | UUID sama + payload identik setelah status `succeeded` | `409 Conflict` | `{"error":{"message":"Request has already been processed.","type":"requests","param":null,"code":"request_already_processed"},"outcome":{"status":"succeeded","original_http_status":200,"original_error_code":null,"completed_at":1793664000}}` | Metadata memuat status `succeeded`. **Assertion: Provider TIDAK dipanggil ulang; kuota tidak berkurang.** |
| `TC-REQ6-IDM-03` | Req 6, AC 4 | **Retry setelah gagal/batal/expired** | UUID sama + payload identik setelah `failed` / `cancelled` / `lease_expired` | `409 Conflict` | `{"error":{"message":"Request has already been processed.","type":"requests","param":null,"code":"request_already_processed"},"outcome":{"status":"failed"|"cancelled"|"lease_expired","original_http_status":502|499|503,"original_error_code":"...","completed_at":...}}` | Metadata memuat status terminal asli tanpa memanggil provider ulang. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ6-IDM-04A` | Req 6, AC 2; Req 6, AC 4 | **Retry penolakan rate limit tepat sebelum pergantian menit UTC (Jendela aktif)** | UUID sama + payload identik yang tercatat `rejected` dengan `rate_limit_exceeded` pada detik `S` di jendela menit `M`. Klien retry pada detik `59.999` (tepat sebelum pergantian menit UTC, jendela asal masih aktif). | `429 Too Many Requests` | `{"error":{"message":"Rate limit exceeded.","type":"requests","param":null,"code":"rate_limit_exceeded"},"outcome":{"status":"rejected","original_http_status":429,"original_error_code":"rate_limit_exceeded","completed_at":...}}` | Header `Retry-After` **hadir** dengan nilai sisa detik hingga akhir jendela menit penolakan asal (`Retry-After: 1` atau sisa detik terhitung). Metadata `outcome` mencatat penolakan asal. **Assertion: Provider TIDAK dipanggil ulang; kuota rate tidak dinaikkan.** |
| `TC-REQ6-IDM-04B` | Req 6, AC 2; Req 6, AC 4 | **Retry penolakan rate limit tepat setelah pergantian menit UTC (Jendela asal telah berakhir)** | UUID sama + payload identik yang tercatat `rejected` dengan `rate_limit_exceeded` pada menit `M`. Klien retry pada detik `00.000` atau sesudahnya di menit `M+1` (setelah jendela penolakan asal berakhir, tetapi masih dalam masa retensi deduplikasi 24 jam). | `429 Too Many Requests` | `{"error":{"message":"Rate limit exceeded.","type":"requests","param":null,"code":"rate_limit_exceeded"},"outcome":{"status":"rejected","original_http_status":429,"original_error_code":"rate_limit_exceeded","completed_at":...}}` | Header `Retry-After` **DIHILANGKAN (omitted / tidak ada)** karena jendela penolakan asal telah berakhir (tidak boleh mengirim nilai 0, negatif, atau kedaluwarsa). Metadata `outcome` tetap mempertahankan penolakan asal. **Assertion: Provider TIDAK dipanggil ulang; kuota rate tidak dinaikkan.** |
| `TC-REQ6-IDM-04C` | Req 6, AC 2; Req 6, AC 4 | **Retry penolakan concurrency limit (Sebelum & sesudah pergantian menit UTC)** | UUID sama + payload identik yang tercatat `rejected` dengan `concurrency_limit_exceeded`. Klien retry pada waktu mana pun selama masa retensi deduplikasi 24 jam (baik di menit yang sama maupun menit berikutnya). | `429 Too Many Requests` | `{"error":{"message":"Concurrency limit exceeded.","type":"requests","param":null,"code":"concurrency_limit_exceeded"},"outcome":{"status":"rejected","original_http_status":429,"original_error_code":"concurrency_limit_exceeded","completed_at":...}}` | Header `Retry-After: 1` **selalu hadir** dengan nilai tetap `1` detik (tidak bergantung pada batas menit UTC). Metadata `outcome` mencatat penolakan concurrency asal. **Assertion: Provider TIDAK dipanggil ulang; slot concurrency tidak diambil.** |
| `TC-REQ6-IDM-05A` | Req 6, AC 4 | **Konflik payload saat request masih berjalan (`running`)** | UUID sama tetapi payload berbeda (prompt/parameter berubah) saat request awal masih berstatus `running` dengan lease aktif (sebelum keputusan terminal dibuat dan sebelum `dedupe_until` ditetapkan) | `409 Conflict` | `{"error":{"message":"Idempotency key already used with different payload.","type":"requests","param":null,"code":"idempotency_conflict"}}` | Ditolak karena kombinasi key sedang dipakai oleh request yang sedang berjalan dengan payload berbeda. **Assertion: Provider TIDAK dipanggil ulang; slot concurrency tidak digandakan.** |
| `TC-REQ6-IDM-05B` | Req 6, AC 4 | **Konflik payload saat status terminal dalam retensi deduplikasi (`t < dedupe_until`)** | UUID sama tetapi payload berbeda saat request awal telah berstatus terminal (`succeeded`, `failed`, `cancelled`, `lease_expired`, atau `rejected`), dan waktu retry masih dalam masa retensi deduplikasi (`t < dedupe_until`) | `409 Conflict` | `{"error":{"message":"Idempotency key already used with different payload.","type":"requests","param":null,"code":"idempotency_conflict"}}` | Ditolak karena satu UUID tidak boleh dipakai untuk payload berbeda selama masa retensi deduplikasi masih aktif (`t < dedupe_until`). Setelah batas retensi berlalu (`t >= dedupe_until`), UUID diizinkan membawa payload berbeda sebagai admission baru (lihat `TC-REQ6-24H-03`). **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ6-IDM-06` | Req 6, AC 4 | **Equivalence - Urutan Key JSON** | `{"model":"m", "messages":[...]}` vs `{"messages":[...], "model":"m"}` | `200 OK` (atau matching outcome) | Sidik SHA-256 identik | Normalisasi mengabaikan urutan key JSON; tidak memicu `idempotency_conflict`. |
| `TC-REQ6-IDM-07` | Req 6, AC 4 | **Equivalence - Stream Boolean** | `"stream": false` vs field `stream` dihilangkan | `200 OK` (atau matching outcome) | Sidik SHA-256 identik | Field `stream` yang dihilangkan dinormalisasi menjadi `false`. |
| `TC-REQ6-IDM-08` | Req 6, AC 4 | **Equivalence - Angka Numerik** | `temperature: 1` vs `temperature: 1.0` | `200 OK` (atau matching outcome) | Sidik SHA-256 identik | Normalisasi membandingkan nilai numerik murni. |
| `TC-REQ6-IDM-09` | Req 6, AC 4 | **Non-equivalence - Omitted vs Explicit** | `temperature` dihilangkan vs `temperature: 1.0` | `409 Conflict` | `idempotency_conflict` (bila UUID sama) | Opsi tidak dikirim dianggap distinct dari opsi yang dikirim eksplisit. |
| `TC-REQ6-IDM-10` | Req 6, AC 4 | **Isolasi Lintas API Key** | UUID sama dikirim oleh API Key B di project yang sama | Diproses independen | Keputusan admission baru | Keputusan diisolasi ketat per kombinasi `(project_id, api_key_id, UUID)`. Key B tidak dapat melihat hasil Key A. |

---

### 2.5 Batas Kuota 1.000 Penolakan `rejected` per Project per Hari UTC
- **Rujukan Kontrak:** Requirement 6, AC 4; Approved Design.
- **Aturan Batas:** Paling banyak 1.000 keputusan `rejected` baru per project per hari UTC. Penolakan ke-1.001 tetap menerima `429` tetapi **tanpa penyimpanan record** dan **tanpa objek `outcome`**.

| ID Kasus Uji | AC Ref | Kategori Batas | Kondisi Lonjakan / Waktu | Status HTTP | Ekspektasi Isi Respons | Assertion Penyimpanan Atlas & Provider |
|---|---|---|---|---|---|---|
| `TC-REQ6-REJ-LIM-01` | Req 6, AC 4 | **Tepat pada batas kuota catat (Ke-1.000)** | Penolakan ke-1.000 pada hari UTC yang sama | `429 Too Many Requests` | Memuat pesan error `429`. Retry dengan UUID yang sama memuat metadata `outcome` | Record ke-1.000 berhasil ditulis ke koleksi `request_decisions` dengan `status: "rejected"`. **Assertion: Provider TIDAK dipanggil.** |
| `TC-REQ6-REJ-LIM-02` | Req 6, AC 4 | **Di luar batas kuota catat (Ke-1.001)** | Penolakan ke-1.001 pada hari UTC yang sama | `429 Too Many Requests` | `{"error":{"message":"Project rate limit exceeded...","type":"requests","param":null,"code":"rate_limit_exceeded"}}` (**TANPA objek `outcome`**) | Transaksi admission **TIDAK MENULIS** dokumen ke `request_decisions` (kuota 1.000 habis). **Assertion: Provider TIDAK dipanggil; Atlas tidak menyimpan record baru.** |
| `TC-REQ6-REJ-LIM-03` | Req 6, AC 4 | **Retry UUID yang tidak tercatat (Ke-1.001)** | Klien mengulang request memakai UUID yang sebelumnya ditolak pada penolakan ke-1.001 | Dinilai ulang terhadap kuota aktif saat retry | Jika menit baru tiba: `200 OK` (admission baru diterima). Jika masih penuh: `429` tanpa `outcome` | Karena UUID awal tidak tercatat, retry diperlakukan sebagai admission baru. **Assertion: Idempotensi & pemulihan terminal tidak dijamin untuk penolakan di atas 1.000/hari; provider dipanggil bila kuota baru mengizinkan.** |
| `TC-REQ6-REJ-LIM-04` | Req 6, AC 4 | **Batas pergantian hari UTC (Reset Kuota Catat)** | Tepat `00:00:00.000Z` UTC hari berikutnya | `429 Too Many Requests` | Penolakan pertama di hari baru kembali ditulis ke Atlas dan memuat `outcome` pada retry | Penghitung 1.000 penolakan harian direset otomatis pada awal hari UTC baru. |

---

### 2.6 Batas Waktu Retensi Deduplikasi 24 Jam (86.400 Detik)
- **Rujukan Kontrak:** Requirement 6, AC 4; Approved Design lines 198-208.
- **Aturan Batas & Penyelarasan:**
  - **Titik Awal & Formula:** Sesuai `approved-design.md` baris 206, saat keputusan menjadi terminal, transaksi admission/terminal menetapkan `terminal_at` dari waktu penjaga Atlas dan `dedupe_until = terminal_at + 24 jam` (86.400 detik). Jaminan retensi "sedikitnya 24 jam" pada `requirements.md` Req 6 AC 4 berakhir tepat saat `terminal_at + 86.400s` tercapai.
  - **Sebelum `dedupe_until` (`t < dedupe_until`, misal `terminal_at + 86.399s`):** Request pengulangan dianggap sebagai retry keputusan lama, mengembalikan status terminal tersimpan (`409` atau `429`) beserta objek `outcome`. Provider TIDAK dipanggil ulang.
  - **Tepat pada atau setelah batas (`t >= dedupe_until`, misal `terminal_at + 86.400s`):** Masa retensi 24 jam telah genap. UUID diizinkan dipakai kembali untuk admission baru. Transaksi admission menggunakan pembandingan atomik terhadap klaim terminal yang telah melewati `dedupe_until` (`dedupe_until <= current_server_time`), menghapus/menggantikan keputusan lama, dan membuat admission baru secara atomik.
  - **Independensi terhadap Background TTL:** Ketepatan jendela deduplikasi **tidak bergantung pada jadwal penghapusan background TTL Atlas**. Transaksi admission baru wajib berhasil membuat admission baru tepat pada atau setelah `dedupe_until` meskipun dokumen keputusan lama masih tersimpan di Atlas (karena TTL runner belum berjalan).
  - **Penggunaan Ulang Payload Berbeda:** Setelah melewati `dedupe_until`, UUID yang sama boleh membawa payload berbeda tanpa memicu `409 idempotency_conflict`, dan diperlakukan sebagai admission baru seutuhnya. Sebaliknya, selama request masih berjalan (`running`) atau dalam masa retensi aktif (`t < dedupe_until`), payload berbeda wajib ditolak dengan `409 idempotency_conflict` (lihat `TC-REQ6-IDM-05A` dan `TC-REQ6-IDM-05B`).

| ID Kasus Uji | AC Ref | Kategori Batas | Waktu Retry Relatif sejak Terminal (`terminal_at`) | Ekspektasi Respons HTTP | Ekspektasi Format Body & Metadata | Assertion Perilaku Sistem & Provider |
|---|---|---|---|---|---|---|
| `TC-REQ6-24H-01` | Req 6, AC 4 | **Tepat sebelum batas retensi deduplikasi (Off-by-one inside: T + 86.399s)** | Detik `terminal_at + 86.399s` (`t < dedupe_until`) | `409 Conflict` (atau `429 Too Many Requests` jika rejected) | Memuat pesan error terminal asli dan objek metadata `outcome` (`status`, `original_http_status`, `original_error_code`, `completed_at`) | Request masih dalam jendela retensi deduplikasi aktif. Mengembalikan keputusan tersimpan tanpa membuat admission baru. **Assertion: Provider TIDAK dipanggil ulang; kuota rate tidak dinaikkan.** |
| `TC-REQ6-24H-02` | Req 6, AC 4 | **Tepat pada batas retensi deduplikasi saat record TTL belum dihapus (On-boundary: T + 86.400s)** | Detik `terminal_at + 86.400s` (`t = dedupe_until`), dokumen lama **masih ada di Atlas** (background TTL belum berjalan) | `200 OK` (jika kuota tersedia) atau `429` (jika kuota menit/concurrency berjalan penuh) | Respons inferensi provider baru (atau error rate limit baru untuk menit aktif). **TANPA objek `outcome` dari keputusan lama** | Evaluasi atomik dalam transaksi admission mendeteksi `dedupe_until <= current_server_time`, mengganti record lama secara atomik, dan membuat admission baru tanpa menunggu penghapusan fisik oleh TTL Atlas. **Assertion: Provider dipanggil hanya bila admission baru diterima dan commit; jika hasilnya `429`, provider TIDAK dipanggil.** |
| `TC-REQ6-24H-03` | Req 6, AC 4 | **Di luar batas retensi deduplikasi dengan payload berbeda (> 24 jam / T + 86.401s)** | Detik `terminal_at + 86.401s` (`t > dedupe_until`) dengan UUID sama tetapi **payload/prompt berbeda** | `200 OK` (jika kuota tersedia) atau `429` (jika kuota menit/concurrency berjalan penuh) | Respons inferensi baru untuk payload baru (atau error rate limit baru jika kuota penuh). **TANPA objek `outcome` dari keputusan lama** | Karena jendela `dedupe_until` telah terlampaui, perbedaan payload TIDAK memicu `409 idempotency_conflict`. Gateway memperlakukan request sebagai admission baru. **Assertion: Provider dipanggil dengan payload baru hanya bila admission baru diterima dan commit; jika hasilnya `429`, provider TIDAK dipanggil.** |

---

### 2.7 Batas Kegagalan State Store & Pemulihan Commit Tidak Diketahui
- **Rujukan Kontrak:** Requirement 6, AC 5; Approved Design.

| ID Kasus Uji | AC Ref | Skenario Gangguan | Titik Kegagalan | Ekspektasi HTTP Status | Ekspektasi Kode Error | Assertion & Tindakan Terhadap Provider |
|---|---|---|---|---|---|---|
| `TC-REQ6-FAIL-01` | Req 6, AC 5 | Koneksi Atlas putus sebelum transaksi | Sebelum transaksi dimulai | `503 Service Unavailable` | `limiter_unavailable` | Provider **TIDAK PERNAH DIPANGGIL**; kuota rate tidak berkurang. |
| `TC-REQ6-FAIL-02` | Req 6, AC 5 | Hasil commit tidak diketahui (Koneksi putus saat commit) | Saat commit transaksi admission | `503 Service Unavailable` | `limiter_unavailable` | Gateway melakukan read majority ulang. Jika status tetap tidak pasti sebelum timeout, **JANGAN PANGGIL PROVIDER**. Transaksi yang ternyata commit menghitung 1 kuota dan 1 lease. |
| `TC-REQ6-FAIL-03` | Req 6, AC 5 | Retry setelah transaksi dipastikan abort | Transaksi awal dipastikan abort | `200 OK` (pada retry baru) | Admission baru berhasil | Retry diizinkan membuat keputusan admission baru tanpa penalti kuota ganda. Provider dipanggil setelah admission baru commit. |
| `TC-REQ6-FAIL-04` | Req 6, AC 5 | Retry UUID setelah transient abort | Transaksi awal abort, UUID dipakai lagi | Dievaluasi sebagai percobaan baru | Admission baru dibuat | UUID yang gagal commit tidak meninggalkan record menggantung yang memblokir percobaan berikutnya. |
