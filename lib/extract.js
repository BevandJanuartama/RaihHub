import { z } from "zod";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { generateJson } from "./gemini.js";

// Harus sama dengan isi tabel `domains` di supabase/001_init.sql
export const DOMAINS = [
  "it", "data_ai", "bisnis", "ekonomi", "hukum", "kesehatan", "teknik",
  "sains", "desain", "sosial_humaniora", "pendidikan", "pertanian",
  "komunikasi", "umum",
];

const OpportunitySchema = z.object({
  page_type: z
    .enum(["open_call", "news_result", "listing", "other"])
    .describe(
      "open_call = info/pengumuman pendaftaran satu peluang yang masih atau akan dibuka; " +
        "news_result = berita juara/pemenang/prestasi, liputan acara, pengumuman hasil seleksi; " +
        "listing = kumpulan banyak peluang; other = selain itu",
    ),
  has_registration_info: z
    .boolean()
    .describe("true jika halaman memuat cara/link/periode pendaftaran untuk peluang ini"),
  title: z.string().describe("Nama resmi peluang (bukan judul berita), mis. 'Beasiswa LPDP 2027 Tahap 1'"),
  category: z.enum(["lomba", "magang", "beasiswa"]),
  organizer: z.string().nullable(),
  deadline: z.string().nullable().describe("Batas pendaftaran, format YYYY-MM-DD; null jika tidak disebut"),
  domains: z.array(z.enum(DOMAINS)),
  tags: z.array(z.string()).describe("3-8 tag spesifik huruf kecil, mis. 'python', 'esai', 'ui/ux'"),
  eligible_levels: z.array(z.enum(["D3", "D4", "S1", "S2", "S3"])),
  eligible_majors: z.array(z.string()),
  is_general: z.boolean().describe("true jika terbuka untuk semua jurusan/bidang"),
  requirements: z.array(z.string()),
  registration_url: z
    .string()
    .nullable()
    .describe("Link langsung untuk mendaftar (form, portal pendaftaran)"),
  official_url: z
    .string()
    .nullable()
    .describe(
      "Halaman resmi/detail peluang: website penyelenggara, akun Instagram/TikTok/Facebook/X, linktree, atau guidebook",
    ),
  summary: z.string().describe("Ringkasan 2 kalimat dalam bahasa Indonesia"),
});

const SYSTEM = `Kamu mengekstrak informasi peluang mahasiswa (lomba, magang, beasiswa) dari teks halaman web Indonesia.
Aturan:
- Gunakan hanya fakta yang tertulis di teks. Jangan mengarang deadline, penyelenggara, atau link; isi null bila tidak ada.
- domains wajib dipilih dari daftar enum. Bila peluang terbuka untuk semua jurusan, sertakan "umum" dan set is_general=true.
- eligible_levels dan eligible_majors dibiarkan kosong bila tidak ada batasan.
- Tanggal relatif atau tanpa tahun dikonversi ke YYYY-MM-DD memakai tanggal hari ini yang diberikan.
- Platform ini hanya menampilkan peluang yang BISA DIDAFTAR mahasiswa. Bedakan dengan tegas:
  • open_call: "Pendaftaran Lomba X dibuka", "Beasiswa LPDP 2027", "Lowongan Magang Y", guidebook/timeline/syarat pendaftaran.
  • news_result: "Tim A Raih Juara 1 Lomba X", "Mahasiswa B lolos/menang/meraih medali", liputan final, pengumuman pemenang, penerima beasiswa. Ini BUKAN peluang walau menyebut nama lomba.
- registration_url dan official_url hanya boleh diambil dari daftar link kandidat atau tertulis jelas di teks; jangan mengarang. Utamakan link milik penyelenggara (website resmi, Instagram/TikTok/Facebook resmi, linktree, form pendaftaran).
- Jika info jelas untuk periode yang sudah lewat (mis. "Tahun 2024", deadline sebelum tanggal hari ini) dan tidak ada periode pendaftaran baru, set page_type="other".
- category "magang" hanya untuk program magang/internship/pemagangan. Lowongan kerja tetap/full-time/kontrak biasa → page_type="other".
- Formulir konsultasi/pendaftaran layanan agen pendidikan (bukan pendaftaran ke penyelenggara beasiswa) bukan registration_url.
- Platform ini untuk mahasiswa (D3-S3) dan lulusan SMA yang akan kuliah. Jika peluang hanya untuk siswa SD/SMP/SMA (mis. beasiswa masuk SMA), set page_type="other".`;

const REGISTER_RE = /daftar|regist|apply|pendaftaran|submit|form|bit\.ly|forms\.gle|s\.id|tinyurl|linktr\.ee/i;
const OFFICIAL_RE =
  /instagram\.com|tiktok\.com|facebook\.com|fb\.com|x\.com|twitter\.com|linkedin\.com|youtube\.com|linktr\.ee|bio\.link|lynk\.id|drive\.google\.com|docs\.google\.com|\.ac\.id$|\.go\.id$|\.or\.id$/i;
// Tombol "bagikan" bukan link resmi
const SHARE_RE = /sharer|share\?|intent\/tweet|whatsapp\.com\/send|wa\.me\/\?|pinterest\.com\/pin|t\.me\/share|mailto:/i;

/** Ambil teks utama halaman + link kandidat pendaftaran/resmi + hash untuk dedup. */
export function cleanHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const meta = (p) => ($(`meta[property="${p}"]`).attr("content") || $(`meta[name="${p}"]`).attr("content") || "").trim();
  const ogTitle = meta("og:title");
  const desc = meta("og:description") || meta("description");

  $("script,style,nav,footer,header,aside,form,iframe,noscript,svg,button").remove();
  $(".modal,[role=dialog],[class*=popup],[class*=cookie],[class*=share],[class*=related],[class*=comment],[class*=sidebar],[class*=widget]").remove();
  $("p,br,li,h1,h2,h3,h4,h5,h6,div,tr,td,th").append(" "); // cegah kata menempel antar-blok

  // Pilih blok konten utama secara generik: teks terbanyak, bukan kumpulan link
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  let best = null;
  let bestScore = 0;
  $(
    'article, main, [role=main], [class*="detail"], [class*="content"], [class*="post"], [class*="entry"], [class*="single"], [class*="article"], [id*="content"], [id*="post"]',
  ).each((_, el) => {
    const t = norm($(el).text());
    if (t.length < 300) return;
    const linkText = norm($(el).find("a").text()).length;
    const density = linkText / t.length; // halaman listing: hampir semua teks adalah link
    const score = t.length * (1 - density) ** 2;
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  });
  const main = best ? $(best) : $("body");
  const heading = norm(main.find("h1,h2,h3").first().text());
  const title = (heading.length > 8 ? heading : "") || ogTitle || norm($("title").text());

  const text = norm(
    `${ogTitle && ogTitle !== title ? ogTitle + ". " : ""}${desc ? desc + ". " : ""}${main.text()}`,
  ).slice(0, 12000);

  // Link kandidat: link pendaftaran + link resmi (sosmed, linktree, guidebook, domain lain)
  const baseHost = new URL(baseUrl).host.replace(/^www\./, "");
  const seen = new Set();
  const scored = [];
  $("a[href]").each((_, a) => {
    let href;
    try {
      href = new URL($(a).attr("href"), baseUrl).href;
    } catch {
      return;
    }
    if (!/^https?:/.test(href) || seen.has(href)) return;
    seen.add(href);
    const anchor = $(a).text().replace(/\s+/g, " ").trim().slice(0, 80);
    const host = new URL(href).host.replace(/^www\./, "");
    const s = `${anchor} ${href}`;
    let score = 0;
    if (REGISTER_RE.test(s)) score += 3;
    if (OFFICIAL_RE.test(host)) score += 2;
    if (/guide ?book|juknis|panduan|booklet|timeline/i.test(s)) score += 2;
    if (host !== baseHost && !SHARE_RE.test(href)) score += 1;
    if (score > 0) scored.push({ score, line: `${anchor || "(tanpa teks)"} -> ${href}` });
  });
  const links = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .map((x) => x.line);

  const hash = crypto.createHash("sha256").update(text).digest("hex");
  return { title, text, links, hash };
}

/** Kirim teks halaman ke Gemini dan kembalikan objek peluang tervalidasi, atau null. */
export async function extractOpportunity({ url, text, links }) {
  const o = await generateJson({
    schema: OpportunitySchema,
    systemInstruction: SYSTEM,
    contents:
      `Tanggal hari ini: ${new Date().toISOString().slice(0, 10)}\n` +
      `URL halaman: ${url}\n` +
      `Link kandidat (pendaftaran / resmi):\n${links.join("\n") || "(tidak ada)"}\n\n` +
      `TEKS HALAMAN:\n${text}`,
  });
  if (!o) return { ok: false, reason: "gagal" };
  if (o.page_type !== "open_call") return { ok: false, reason: o.page_type };
  if (!o.has_registration_info && !o.registration_url && !o.official_url)
    return { ok: false, reason: "tanpa_info_daftar" };
  return { ok: true, data: o };
}

// Judul berita prestasi yang jelas bukan peluang → tidak perlu dikirim ke LLM
export const NEWS_TITLE_RE =
  /\b(raih|meraih|sabet|menyabet|boyong|memboyong|borong|memborong|rebut|merebut|sapu bersih)\s+(juara|gelar|medali|emas|perak|perunggu|gold|silver|bronze|predikat|penghargaan)|\bjuara\s+(umum|[1-3i]+)\b.*\b(tim|mahasiswa|delegasi)\b|\b(tim|mahasiswa|delegasi)\b.*\bjuara\b|^(gemilang|selamat|bangga|keren|hebat)\b|\b(pemenang|penerima|pengumuman hasil|hasil seleksi|lolos final|finalis)\b/i;

// ---------- CV ----------
const CvSchema = z.object({
  skills: z.array(z.string()).describe("Skill teknis dan soft skill, huruf kecil, maksimal 25"),
  domains: z.array(z.enum(DOMAINS.filter((d) => d !== "umum"))),
  summary: z.string().describe("Ringkasan latar belakang pendidikan & pengalaman, 2-3 kalimat bahasa Indonesia"),
});

/** Parse CV (PDF) menjadi skills, domains, summary. */
export function parseCv(pdfBuffer) {
  return generateJson({
    schema: CvSchema,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "application/pdf", data: pdfBuffer.toString("base64") } },
          {
            text: "Ekstrak skills, domain keahlian, dan ringkasan latar belakang dari CV ini. Jangan sertakan data kontak pribadi (alamat, nomor HP, email).",
          },
        ],
      },
    ],
  });
}
