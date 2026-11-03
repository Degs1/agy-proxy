# Audit formal kontrak MVP — TASK-090

**Peninjau:** Reza (Code Reviewer)

**Tanggal audit:** 2026-11-03

**Keputusan:** **REQUEST CHANGES — kontrak belum disetujui dan belum frozen.**

**Gerbang:** implementasi yang bergantung pada kontrak tidak boleh diperlakukan final sebelum koreksi di bawah ditutup dan versi hasil koreksi diaudit ulang.

## Snapshot yang ditinjau

Basis worktree adalah commit TASK-001 `455a5f8292dcb3948ce09b449a9306b1bffb6702` (parent `f24cb08e186ad93495f42bcc909d82e00d7094d5`). Tidak ada perubahan lokal pada enam berkas sebelum audit. Versi sumber, matriks keputusan, matriks uji, dan registri sumber yang ditinjau adalah objek Git berikut, bukan versi yang mungkin berubah setelah audit ini.

| Berkas | Git blob SHA-1 pada basis | SHA-256 UTF-8 dengan akhir baris LF |
| --- | --- | --- |
| `docs/contract/requirements.md` | `49ad505556c00df4515202be6360ef6564d260c8` | `480d0d32ce0ddf1ef13008b27b4f11d6b8d0926ed23748260880db625c6d444d` |
| `docs/contract/approved-design.md` | `00c70a3d72490c99281e72333139bf101d296d54` | `b27b532e2a0128d9a9aa626e5b256260639a95e2c9bcd564cfc944b6f16e21fa` |
| `docs/PRD.md` (baseline `f24cb08e186ad93495f42bcc909d82e00d7094d5`) | `3ac0deaa8519dc256d261baf5765ed48a06ac217` | `628fb4e048ecae814bbaa4f8d9214cffc21b7c8474f39514449cc563a95cdc8b` |
| `docs/contract/decision-matrix.md` | `7bb6ba9d5ff8b2876c1317835abea882fc3731b6` | `9937d64ff560d1570fb7ba9a2e827664477ec2eec80a76717c1cef9c8f6f4c10` |
| `docs/contract/test-matrix.md` | `43fc47819f573634d2bcfba5cf686318d9a3315d` | `26280ad027e314fa22eac9c4667ef7a57f76b1dfcfd716a6f9cb8fe674ae3c8c` |
| `docs/contract/sources.md` | `50eb8b0c8735ead7f325ace442b4101c3159a737` | `64af02021cd043b552e4d9589e54303486eb6c4ae1ce1d65908ce850359f4a82` |

**Bukti integritas:** saya menjalankan `git ls-tree HEAD` dan prosedur A (`git hash-object`) dari `sources.md` atas tiga berkas sumber. Semua nilai cocok dengan tabel `sources.md`. Saya menjalankan prosedur B (`node -e` dengan normalisasi `CRLF/CR` menjadi `LF` dan SHA-256) atas tiga sumber dan tiga dokumen matriks/registri; semua nilai di atas dihitung dari berkas nyata. Checkout lokal memakai CRLF, sedangkan blob Git tersimpan dengan LF; nilai `git hash-object` cocok dengan objek di tree setelah filter Git. Hash mentah checkout bukan acuan lintas platform. Ini memverifikasi identitas isi, bukan persetujuan atas isinya.

## Pemetaan acceptance criterion Must

Pemeriksaan ini menilai **keberadaan dan ketepatan spesifikasi kasus**, bukan hasil uji implementasi. `Requirement 11, AC 1` dalam `requirements.md` memuat tabel *flow minimum*; `Requirement 11, AC 2` memuat tabel *pengujian tambahan wajib*. Keduanya menyediakan pemetaan kasus untuk requirement di luar fokus `test-matrix.md`. Nomor AC di bawah diperiksa langsung terhadap berkas tersebut.

| Requirement Must | AC yang ada | Rujukan kasus/gerbang dalam snapshot | Hasil audit pemetaan |
| --- | --- | --- | --- |
| 1 (M1) | 1–3 | Req 11 AC 1: pembatasan lintas instance; AC 2: foundation dan konfigurasi | Terpetakan sebagai skenario wajib; bukti eksekusi belum menjadi bagian audit kontrak. |
| 2 (M1) | 1–4 | Req 11 AC 1: bootstrap dan sesi admin, pembatasan login; AC 2: pembatasan login lintas instance | Terpetakan sebagai skenario wajib. |
| 3 (M1) | 1–6 | Req 11 AC 1: admin dan konfigurasi, penonaktifan, isolasi project, kunci enkripsi; AC 2: transaksi admission | Terpetakan sebagai skenario wajib. |
| 4 (M2) | 1–4 | Req 11 AC 1: isolasi project, nonstream, keluaran provider; AC 2: kontrak adapter | Terpetakan; kasus error jaringan di `TC-REQ5-ERR-05` bertentangan dengan AC 3. |
| 5 (M2) | 1–5 | `TC-REQ5-BODY-*`, `MSG-LEN-*`, `CNT-LEN-*`, `SEQ-*`, `NUM-*`, `IDEM-*`, `AUTH-*`, `EXT-*`, `RES-*`, `ERR-*`, `MOD-*`; Req 11 AC 1–2 | Semua nomor AC mempunyai kasus. Koreksi terbuka pada `TC-REQ5-ERR-05`; lihat temuan 1. |
| 6 (M2) | 1–5 | `TC-REQ6-RPM-*`, `CNC-*`, `LSE-*`, `IDM-*`, `REJ-LIM-*`, `24H-*`, `FAIL-*`; Req 11 AC 1–2 | Semua nomor AC mempunyai kasus. Koreksi terbuka pada batas 24 jam dan retry penolakan; lihat temuan 2–3. |
| 7 (M2) | 1–5 | Req 11 AC 1: stream selesai, keluaran provider bermasalah, timeout, pemulihan slot; AC 2: transaksi dan batas lease | Terpetakan sebagai skenario wajib. |
| 8 (M3) | 1–4 | Req 11 AC 1: monitoring dan kerahasiaan, admin dan konfigurasi | Terpetakan sebagai skenario wajib. |
| 9 (M3) | 1–4 | Req 11 AC 1: admin dan konfigurasi; AC 2: desain dan dashboard | Terpetakan sebagai skenario wajib. |
| 11 (M4) | 1–5 | AC 1–2 menetapkan flow dan uji tambahan; AC 3 menetapkan gerbang lulus/gagal; AC 4 verifikasi deployment; AC 5 catatan keputusan rilis | Kriteria proses review/rilis; bukti eksekusi baru dinilai pada milestone terkait. |

Requirement 10 ditandai *Should*, sehingga tidak dihitung sebagai AC Must. Seluruh 45 nomor AC Must (3+4+6+4+5+5+5+4+4+5) memiliki rujukan skenario atau gerbang proses, tetapi keberadaan rujukan saja tidak membuktikan hasil atau konsistensi ekspektasi.

### Pemeriksaan khusus Requirement 5 dan 6

- **Req 5 AC 1:** body tepat/di atas 1 MiB; 1, 64, 65 pesan; panjang konten UTF-8; urutan peran; batas temperatur 0/2 dan `max_tokens` 1/8192; UUID: `TC-REQ5-BODY-*`, `MSG-LEN-*`, `CNT-LEN-*`, `SEQ-*`, `NUM-*`, `IDEM-*` (baris 11–104). Penolakan menyatakan provider tidak dipanggil.
- **Req 5 AC 2:** struktur JSON, satu pilihan, alasan selesai, dan `usage: null`: `TC-REQ5-RES-01`–`05` (baris 137–146).
- **Req 5 AC 3:** auth, isolasi model, bentuk error, dan `GET /v1/models`: `TC-REQ5-AUTH-*`, `MOD-*` (baris 121–175). Kasus model list adalah kontrak PRD; Requirement 5 sendiri terutama mendefinisikan POST.
- **Req 5 AC 4–5:** penolakan field ekstra/multimodal (`TC-REQ5-EXT-01`–`07`) dan hasil provider bermasalah (`TC-REQ5-ERR-01`–`06`). Kasus error jaringan perlu dipisah; lihat temuan 1.
- **Req 6 AC 1–3:** batas menit UTC 60/61, 5/6 slot, lease sebelum/pada/setelah 45 detik dan renewal 15 detik: `TC-REQ6-RPM-*`, `CNC-*`, `LSE-*` (baris 181–219).
- **Req 6 AC 4:** retry berjalan/terminal/ditolak, sidik request, isolasi key, penolakan ke-1.000/1.001, retensi: `TC-REQ6-IDM-*`, `REJ-LIM-*`, `24H-*` (baris 222–262). Ekspektasi retensi dan `Retry-After` belum lengkap; lihat temuan 2–3.
- **Req 6 AC 5:** Atlas tidak tersedia, commit tidak pasti, abort dan retry: `TC-REQ6-FAIL-01`–`04` (baris 265–273).

## Status lima koreksi review awal TASK-001

| Koreksi awal | Hasil pemeriksaan langsung | Status |
| --- | --- | --- |
| Status persetujuan terlalu dini (`decision-matrix.md`) | Bagian 2 butir 4 kini menyebut menunggu review formal TASK-004 dan pembekuan setelah `review.md`. | **Tertutup** untuk klaim persetujuan; keputusan audit ini tetap request changes. |
| Cakupan Req 5: model list, respons nonstream, error provider | `TC-REQ5-MOD-*`, `RES-*`, dan `ERR-*` telah ditambahkan. `ERR-05` masih salah untuk koneksi yang tidak dapat dijangkau. | **Terbuka sebagian** — temuan 1. |
| Req 6: metadata `outcome`, 24 jam, 1.000 penolakan/hari | `IDM-04` kini memuat `outcome`; `REJ-LIM-01`–`04` memuat batas harian. `24H-01` dan `24H-02` bertentangan dengan desain pada batas tepat 24 jam dan perilaku TTL. | **Terbuka sebagian** — temuan 2; rincian retry pada temuan 3. |
| Hash sumber lintas platform (`sources.md`) | Ketiga Git blob dan SHA-256 LF ternormalisasi dihitung ulang dan cocok; prosedur dapat diulang. | **Tertutup.** |
| Klaim pemulihan lease kurang tepat (`decision-matrix.md`) | Baris keputusan lease kini menyebut admission pertama setelah `expires_at`, tanpa janji request datang dalam 45 detik. | **Tertutup.** |

## Temuan dan koreksi terbuka

1. **[Major] `docs/contract/test-matrix.md:160` — Kondisi provider tak dapat dihubungi diberi status salah.** `TC-REQ5-ERR-05` menggabungkan upstream HTTP 5xx dan socket putus lalu mengharapkan `502 provider_error` untuk keduanya. `requirements.md:89` (Req 4 AC 3) mewajibkan `503 provider_unavailable` bila provider tidak dapat dihubungi. Kasus gabungan dapat meloloskan implementasi yang memberi kode salah. **Perbaikan:** pisahkan respons gagal/penolakan upstream yang menghasilkan `502 provider_error` dari kegagalan koneksi yang memenuhi kondisi *tidak dapat dihubungi* dan menghasilkan `503 provider_unavailable`; pertahankan assertion rahasia tidak bocor dan provider tidak dipanggil ulang.
2. **[Major] `docs/contract/test-matrix.md:256-261` — Batas retensi 24 jam berlawanan dengan desain yang disetujui.** `TC-REQ6-24H-01` mengharapkan keputusan lama tepat pada `T+86.400s`, sedangkan `approved-design.md:206` mengizinkan UUID dipakai kembali **tepat pada atau setelah** `dedupe_until = terminal_at + 24 jam`. `TC-REQ6-24H-02` juga mensyaratkan record sudah dihapus oleh TTL, padahal desain menyatakan penggunaan ulang tidak bergantung pada jadwal TTL. **Perbaikan:** uji `T+86.399s` sebagai retry keputusan lama, `T+86.400s` sebagai admission baru dengan pembandingan atomik terhadap `dedupe_until`, dan kasus TTL belum menghapus record. Gunakan `terminal_at` sebagai titik awal, sesuai desain; bila jaminan *sedikitnya* 24 jam pada Req 6 AC 4 dimaksud inklusif tepat di batas, selaraskan terlebih dulu kalimat requirement dan desain.
3. **[Major] `docs/contract/test-matrix.md:231` — `Retry-After` retry penolakan belum diuji pada sisi lain batas jendela.** `TC-REQ6-IDM-04` hanya menyatakan header diperbarui. Req 6 AC 2 dan `approved-design.md:246` mewajibkan header rate limit **hilang** setelah jendela asal berakhir, sedangkan retry concurrency tetap `Retry-After: 1`; Req 11 AC 1 juga menyebut ini. Tanpa kasus terpisah, implementasi dapat mempertahankan header kedaluwarsa. **Perbaikan:** tambahkan kasus retry UUID tercatat tepat sebelum dan tepat setelah pergantian menit UTC, plus kasus retry penolakan concurrency, dengan status `429`, kode asal, `outcome`, dan nilai/ketiadaan header yang eksplisit.

**Keputusan akhir Reza: Request changes.** Tiga temuan Major di atas adalah blocker persetujuan formal. Bayu perlu memperbaiki matriks/kontrak yang terkait, menerbitkan hash dan commit baru, lalu Reza menghitung ulang hash, memeriksa kembali pemetaan AC terdampak, dan mencatat keputusan audit baru. Tidak ada cap *approved* atau *frozen* untuk snapshot ini. Yang sudah baik: identitas ketiga sumber terverifikasi, keputusan arsitektur utama terlacak, serta sebagian besar batas Req 5–6 sudah memiliki kasus tepat pada dan di luar batas.
