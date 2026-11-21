# RaihHub - Scraper & AI Extraction Service

Layanan otomatisasi pengumpulan informasi peluang mahasiswa (Lomba, Magang, dan Beasiswa) menggunakan automated scraping berkala dan ekstraksi data terstruktur berbasis Google Gemini AI, tersimpan di Supabase dengan dukungan vector embedding & tag-based recommendation.

## ✨ Fitur Utama
- **Automated Web Scraping**: Pengambilan data berkala (jadwal cron setiap 12 jam) dari berbagai portal universitas dan agregator peluang mahasiswa.
- **AI-Powered Extraction**: Mengubah halaman web dan konten informasi mentah menjadi format data terstruktur (Judul, Kategori, Deadline, Syarat, Tag Bidang, Penyelenggara, Link Resmi) menggunakan Google Gemini.
- **Vector Embedding & Recommendation Engine**: Embedding informasi peluang untuk pencarian semantik dan algoritma rekomendasi terpersonalisasi sesuai bidang/keahlian profil pengguna.
- **Supabase Integration**: Penyimpanan database terstruktur dengan PostgreSQL + ekstensi `pgvector`.
- **RESTful API Service**: Endpoint Express.js untuk memicu scraping manual, cek status pipeline, dan integrasi dengan aplikasi frontend.

## 🚀 Persyaratan Sistem
- Node.js v18+
- Akun & Proyek Supabase
- Google Gemini API Key

## 🛠️ Instalasi & Setup

1. **Clone repositori**:
   ```bash
   git clone https://github.com/BevandJanuartama/RaihHub.git
   cd RaihHub
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Konfigurasi Environment**:
   Salin `.env.example` menjadi `.env` dan lengkapi credential:
   ```bash
   cp .env.example .env
   ```
   Isi konfigurasi kunci di `.env`:
   - `SUPABASE_URL`: URL project Supabase kamu
   - `SUPABASE_SERVICE_ROLE_KEY`: Service role secret key Supabase
   - `GEMINI_API_KEY`: API key dari Google AI Studio

4. **Setup Database**:
   Jalankan file SQL migrasi yang ada di folder `supabase/` pada SQL Editor Supabase secara berurutan:
   - `001_init.sql`
   - `002_official_url.sql`
   - `003_open_detail_first.sql`

5. **Jalankan Layanan**:
   ```bash
   npm start
   ```

## 📂 Struktur Direktori
```text
├── data/
│   └── sources.json         # Daftar domain dan sumber target scraping
├── lib/
│   ├── embed.js             # Generator vector embedding
│   ├── extract.js           # Ekstraksi konten dengan Gemini AI
│   ├── gemini.js            # Inisialisasi Google Gen AI client
│   ├── pipeline.js          # Orkestrasi scraping & pemrosesan data
│   ├── sitemap.js           # Crawler dan penjelajah sitemap URL
│   ├── sources.js           # Handler pengelolaan sumber target
│   └── supabase.js          # Inisialisasi client Supabase
├── supabase/                # File skema database & migrasi SQL
├── server.js                # Express server & scheduler cron job
├── .env.example             # Contoh format environment variables
└── README.md
```

## 📄 Lisensi
[ISC](LICENSE)
