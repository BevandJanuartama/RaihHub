# RaihHub - Scraper & AI Extraction Service

Layanan backend berbasis Node.js dan Express untuk mengumpulkan, menyaring, mengekstrak, dan mengindeks informasi peluang mahasiswa (**Lomba**, **Beasiswa**, dan **Magang**) secara otomatis menggunakan web crawling, Google Gemini AI, dan Supabase (`PostgreSQL` + `pgvector`).

## Fitur Utama

- **Automated Discovery & Web Crawling**: Pencarian URL peluang otomatis (DuckDuckGo gratis tanpa API key secara default, atau opsional melalui Serper / Brave Search API), disertai sumber bawaan dan sumber terpelajari (`data/sources.json`), pembacaan `sitemap.xml`, kepatuhan terhadap `robots.txt`, serta pemfilteran spam/tautan tidak relevan.
- **Ekstraksi Data Terstruktur dengan Gemini AI**: Membersihkan konten HTML dan mengekstrak informasi peluang (judul, kategori, penyelenggara, deadline, bidang/domain, tag, jenjang & jurusan yang memenuhi syarat, ringkasan, link pendaftaran, dan link resmi) dengan validasi skema `zod` serta rantai fallback model (`GEMINI_MODELS`).
- **Deduplikasi & Kedaluwarsa Otomatis**: Menghindari pemrosesan ulang konten yang tidak berubah (`content_hash`), menyaring berita prestasi atau duplikat lintas URL, dan menandai peluang yang telah melewati batas waktu sebagai kedaluwarsa (`expire_opportunities`).
- **Vector Embedding & Parsing CV**: Membuat embedding berdimensi 1024 (`gemini-embedding-001`) untuk peluang dan profil mahasiswa (biodata maupun hasil parsing CV PDF dari Supabase Storage bucket `cv`) guna mendukung pencarian dan rekomendasi berbasis kemiripan vektor.
- **Penjadwalan Otomatis & REST API**: Menjalankan siklus scraping terjadwal via `node-cron` (default setiap 12 jam zona waktu `Asia/Jakarta`) dan menyediakan endpoint Express untuk memantau status, memicu crawler, mengambil daftar/detail peluang, serta memperbarui parsing CV dan embedding profil.

## Tech Stack

- **Runtime & Framework**: Node.js (ESM), Express v5
- **Web Scraping & Parsing**: `axios`, `cheerio`, `robots-parser`
- **AI & Embedding**: `@google/genai` (Google Gemini API), `zod`
- **Database & Auth/Storage**: `@supabase/supabase-js` (PostgreSQL + `pgvector`, Supabase Auth JWT, Supabase Storage)
- **Scheduler & Utilitas**: `node-cron`, `dotenv`, `ora`

## Struktur Proyek

```text
├── data/
│   └── sources.json              # Sumber hasil discovery yang dipelajari otomatis
├── lib/
│   ├── embed.js                  # Wrapper pembuatan vector embedding
│   ├── extract.js                # Pembersihan HTML, ekstraksi peluang, & parsing CV via Gemini
│   ├── gemini.js                 # Konfigurasi Google GenAI, retry/cooldown model, & embedding
│   ├── pipeline.js               # Pipeline pemrosesan halaman, CV, profil, & logging ke Supabase
│   ├── sitemap.js                # Pengambilan URL terbaru dari sitemap.xml / robots.txt
│   ├── sources.js                # Daftar sumber bawaan & pengelolaan sumber terpelajari
│   └── supabase.js               # Inisialisasi client Supabase (service role)
├── supabase/
│   ├── 001_init.sql              # Skema awal (pgvector, tabel peluang, profil, interaksi, fungsi)
│   ├── 002_official_url.sql      # Migrasi kolom official_url & pembaruan fungsi feed
│   └── 003_open_detail_first.sql # Migrasi lanjutan urutan/detail tautan peluang
├── .env.example                  # Contoh konfigurasi environment variables
├── package.json                  # Manifest dependensi & skrip npm
└── server.js                     # Entry point Express server, crawler, & cron scheduler
```

## Konfigurasi Environment

Salin file `.env.example` menjadi `.env`, lalu isi nilainya sesuai kebutuhan:

```bash
cp .env.example .env
```

Variabel utama pada `.env.example`:

- **Wajib**:
  - `SUPABASE_URL`: URL proyek Supabase.
  - `SUPABASE_SERVICE_ROLE_KEY`: Service role key Supabase.
  - `GEMINI_API_KEY`: API key Google AI Studio untuk ekstraksi AI, parsing CV, dan embedding.
- **Pengaturan Model & AI (Opsional)**:
  - `GEMINI_MODELS`: Urutan rantai model fallback (default: `gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.8-flash`).
  - `GEMINI_TIMEOUT_MS`: Batas waktu request Gemini dalam milidetik (default: `60000`).
  - `GEMINI_EMBED_MODEL`: Model embedding Gemini (default: `gemini-embedding-001`).
  - `AI_EXTRACT`: Set ke `off` untuk menonaktifkan ekstraksi AI sementara.
  - `EMBEDDINGS`: Set ke `off` untuk menonaktifkan pembuatan embedding.
- **Discovery Pencarian (Opsional)**:
  - `SERPER_API_KEY` / `BRAVE_API_KEY`: API key pencarian web opsional. Jika keduanya kosong, sistem otomatis menggunakan pencarian DuckDuckGo gratis (matikan dengan `FREE_SEARCH=off`).
- **Server, Jadwal & Batas Crawl (Opsional)**:
  - `PORT` (default `5000`), `CORS_ORIGIN` (default `http://localhost:3000` pada `.env.example`), `CRON_SCHEDULE` (default `0 */12 * * *`), `RUN_ON_START` (`true` untuk langsung berjalan saat server nyala), `MAX_RESULTS` (`300`), `PAGES_PER_DOMAIN` (`12`), `PAGES_PER_DISCOVERED` (`3`), `DELAY_MS` (`1500`).

## Instalasi & Menjalankan Layanan

### Prasyarat

- Node.js v18 atau lebih baru
- Proyek Supabase aktif
- Google Gemini API Key

### Langkah Instalasi

1. **Clone repositori**:
   ```bash
   git clone https://github.com/BevandJanuartama/RaihHub.git
   cd RaihHub
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Siapkan environment**:
   Salin `.env.example` ke `.env` dan lengkapi credential yang diperlukan.

4. **Migrasi Database Supabase**:
   Jalankan file SQL di folder `supabase/` secara berurutan melalui **Supabase Dashboard → SQL Editor**:
   1. `supabase/001_init.sql`
   2. `supabase/002_official_url.sql`
   3. `supabase/003_open_detail_first.sql`

5. **Jalankan server**:
   ```bash
   npm start
   ```
   Server berjalan di `http://localhost:5000` (atau sesuai `PORT` di `.env`).

## Ringkasan Endpoint API

- `GET /` — Status crawler (`idle`/`crawling`), statistik terakhir, progres aktif, konfigurasi AI, dan jadwal cron.
- `GET /run` — Memicu satu siklus crawling & ekstraksi secara manual.
- `GET /results` — Mengambil daftar peluang dari Supabase (mendukung query `?category=lomba|beasiswa|magang` dan `?all=1`).
- `GET /opportunities/:id` — Mengambil detail lengkap satu peluang berdasarkan `id`.
- `GET /results/raw` — Mengambil hasil crawl mentah dari siklus terakhir di memori (untuk debugging).
- `GET /dashboard` — Menampilkan halaman HTML ringkasan (`results.html`) bila tersedia.
- `POST /cv/parse` — Memproses file CV PDF pengguna dari Supabase Storage bucket `cv` dan memperbarui profil + embedding (memerlukan header `Authorization: Bearer <access_token>`).
- `POST /profile/refresh` — Memperbarui embedding profil pengguna berdasarkan biodata (memerlukan header `Authorization: Bearer <access_token>`).

## Lisensi

Proyek ini menggunakan lisensi **ISC** sesuai konfigurasi pada `package.json`.
