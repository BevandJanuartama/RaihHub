import "dotenv/config"; // harus paling atas: modul lib/ membaca env saat di-load
import express from "express";
import axios from "axios";
import cron from "node-cron";
import { sb } from "./lib/supabase.js";
import { MODELS as MODEL, lastModelUsed } from "./lib/gemini.js";
import { embeddingsEnabled } from "./lib/embed.js";
import { NEWS_TITLE_RE } from "./lib/extract.js";
import { BUILTIN_SOURCES, learnedSources, recordSource, interleave } from "./lib/sources.js";
import { recentFromSitemap, clearSitemapCache } from "./lib/sitemap.js";
import {
  processPage,
  expireOld,
  logRun,
  newStats,
  processCv,
  refreshProfileEmbedding,
} from "./lib/pipeline.js";
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import fs from "fs";
import ora from "ora";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

// ---------- Konfigurasi (bisa diubah lewat environment variable) ----------
// Batas total halaman relevan per siklus (semua sumber) & per sumber bawaan
const MAX_RESULTS = Number(process.env.MAX_RESULTS) || 300;
const PAGES_PER_DOMAIN = Number(process.env.PAGES_PER_DOMAIN) || 12;
const DELAY_MS = Number(process.env.DELAY_MS) || 1500;
// Jadwal cron (default: setiap 12 jam, jam 00:00 & 12:00 WIB)
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 */12 * * *";
const AI_ENABLED = process.env.AI_EXTRACT !== "off";
const UA =
  process.env.BOT_UA ||
  "CampusInfoBot/1.0 (riset info lomba, beasiswa, magang mahasiswa)";

const YEAR = new Date().getFullYear();

// Kata kunci pencarian otomatis (discovery)
const QUERIES = {
  // Kata kunci diarahkan ke halaman PENDAFTARAN (bukan berita juara)
  lomba: [
    `pendaftaran lomba mahasiswa ${YEAR} guidebook`,
    `open registration kompetisi nasional mahasiswa ${YEAR}`,
    `call for paper lomba karya tulis ilmiah mahasiswa ${YEAR} pendaftaran`,
    `hackathon mahasiswa ${YEAR} daftar sekarang`,
  ],
  beasiswa: [
    `pendaftaran beasiswa S1 ${YEAR} dibuka syarat`,
    `beasiswa mahasiswa aktif ${YEAR} cara daftar`,
    `beasiswa LPDP ${YEAR} pendaftaran`,
  ],
  magang: [
    `lowongan magang mahasiswa ${YEAR} daftar`,
    `internship program mahasiswa Indonesia ${YEAR} apply`,
    `magang bersertifikat ${YEAR} pendaftaran`,
  ],
};

// Pola relevansi per kategori
const PATTERNS = {
  lomba: /lomba|kompetisi|competition|hackathon|olimpiade|call for paper/i,
  beasiswa: /beasiswa|scholarship/i,
  magang: /magang|internship|\bintern\b|kampus merdeka/i,
};

// Filter spam (judi online dsb. sering menyusup di hasil pencarian)
const SPAM =
  /gacor|togel|judi|casino|poker|maxwin|slot88|slot online|slot deposit|deposit \d|situs slot|bandar/i;

// Situs yang tidak bisa / tidak boleh di-crawl
const BLOCKED_HOSTS =
  /(instagram|facebook|tiktok|youtube|twitter|x)\.com$|linkedin\.com$|pinterest\.com$|shopee|tokopedia|wikipedia\.org$/i;
const SKIP_EXT =
  /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|rar|mp4|mp3|css|js|xml|ico|docx?|xlsx?|pptx?)$/i;

// Sumber bawaan + yang dipelajari otomatis: lihat lib/sources.js
// Halaman hasil pencarian biasanya sudah halaman detail → cukup sedikit halaman per domain
const PAGES_PER_DISCOVERED = Number(process.env.PAGES_PER_DISCOVERED) || 3;

// ---------- Helper ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}

function classify(text) {
  for (const [cat, re] of Object.entries(PATTERNS)) {
    if (re.test(text)) return cat;
  }
  return null;
}

const robotsCache = new Map();
async function allowedByRobots(url) {
  const { origin } = new URL(url);
  if (!robotsCache.has(origin)) {
    try {
      const r = await axios.get(`${origin}/robots.txt`, {
        timeout: 7000,
        responseType: "text",
        headers: { "User-Agent": UA },
      });
      robotsCache.set(origin, robotsParser(`${origin}/robots.txt`, r.data));
    } catch {
      robotsCache.set(origin, null); // tidak ada robots.txt -> anggap boleh
    }
  }
  const robots = robotsCache.get(origin);
  return !robots || robots.isAllowed(url, UA) !== false;
}

async function fetchHtml(url) {
  if (!(await allowedByRobots(url))) return null;
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      maxContentLength: 3_000_000,
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    });
    if (!(res.headers["content-type"] || "").includes("text/html")) return null;
    return res.data;
  } catch {
    return null;
  }
}

// ---------- Discovery: cari URL sendiri lewat search API ----------
async function searchSerper(q) {
  const { data } = await axios.post(
    "https://google.serper.dev/search",
    { q, gl: "id", hl: "id", num: 10 },
    {
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    },
  );
  return (data.organic || []).map((r) => r.link);
}

async function searchBrave(q) {
  const { data } = await axios.get(
    "https://api.search.brave.com/res/v1/web/search",
    {
      params: { q, country: "ID", count: 10 },
      headers: {
        "X-Subscription-Token": process.env.BRAVE_API_KEY,
        Accept: "application/json",
      },
      timeout: 10000,
    },
  );
  return (data.web?.results || []).map((r) => r.url);
}

// Pencarian gratis tanpa API key (DuckDuckGo versi HTML). Volume kecil: ~10 kueri per 12 jam.
// Matikan dengan FREE_SEARCH=off. Kalau diblokir/gagal, sistem tetap jalan dengan sumber bawaan.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
async function searchFree(q) {
  const { data } = await axios.get("https://html.duckduckgo.com/html/", {
    params: { q, kl: "id-id" },
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "id-ID,id;q=0.9" },
    timeout: 15000,
  });
  const $ = cheerio.load(data);
  return $("a.result__a")
    .map((_, a) => {
      const href = $(a).attr("href") || "";
      try {
        return new URL(href, "https://duckduckgo.com").searchParams.get("uddg") || href;
      } catch {
        return null;
      }
    })
    .get()
    .filter((u) => u && /^https?:/.test(u))
    .slice(0, 10);
}

async function discover() {
  const sources = [...BUILTIN_SOURCES, ...learnedSources()];
  const [search, name] = process.env.SERPER_API_KEY
    ? [searchSerper, "Serper"]
    : process.env.BRAVE_API_KEY
      ? [searchBrave, "Brave"]
      : process.env.FREE_SEARCH !== "off"
        ? [searchFree, "DuckDuckGo (gratis)"]
        : [null, null];

  if (!search) {
    console.log("[Discovery] Pencarian dimatikan, pakai sumber bawaan + yang dipelajari saja.");
    return interleave(sources);
  }

  let found = 0;
  let failures = 0;
  for (const [category, queries] of Object.entries(QUERIES)) {
    for (const q of queries) {
      try {
        const urls = await search(q);
        for (const u of urls) {
          const url = normalize(u);
          if (!url) continue;
          const { host, pathname } = new URL(url);
          if (BLOCKED_HOSTS.test(host) || SKIP_EXT.test(pathname) || SPAM.test(url)) continue;
          sources.push({ url, category, discovered: true });
          found++;
        }
      } catch (e) {
        failures++;
        console.log(`\n[Discovery] ${name} gagal "${q}": ${e.response?.status || e.code || e.message}`);
        if (failures >= 2 && found === 0) break; // kemungkinan diblokir → jangan dipaksa
      }
      await sleep(search === searchFree ? 3000 : 500);
    }
    if (failures >= 2 && found === 0) break;
  }
  console.log(`\n[Discovery] ${name}: ${found} URL baru ditemukan`);
  return interleave(sources);
}

// ---------- Crawl terfokus ----------
// Prioritas link: halaman detail peluang (slug panjang, ada tahun, anchor seperti judul)
// didahulukan; halaman hub/listing (kategori, "daftar-…", pagination) diakhirkan.
function linkPriority(url, anchor) {
  const { pathname } = new URL(url);
  const slug = pathname.split("/").filter(Boolean).pop() || "";
  const words = slug.split(/[-_]/).filter(Boolean).length;
  let p = 0;
  if (/\/(category|kategori|tag|page|author|search)\//i.test(pathname) || /[?&]page=/.test(url)) p -= 5;
  if (/^(daftar|jadwal|tips|panduan|inspirasi|info|kumpulan|list)-/i.test(slug)) p -= 3;
  if (words >= 3) p += 2;
  if (words >= 5) p += 1;
  if (/20\d\d/.test(slug)) p += 2;
  if (anchor.length >= 30) p += 2;
  if (/dibuka|pendaftaran|deadline|batch|gelombang|open registration|call for/i.test(anchor)) p += 2;
  if (NEWS_TITLE_RE.test(anchor) || /\/(berita|news|prestasi|liputan)\//i.test(pathname)) p -= 4;
  if (/intern|magang|pemagangan|\bojt\b/i.test(`${anchor} ${pathname}`)) p += 3;
  if (/\/(kontak|contact|about|tentang|faq|privacy|kebijakan|login|register|daftar-akun)\b/i.test(pathname)) p -= 6;
  return p;
}

const bareHost = (h) => h.replace(/^www\./, "").toLowerCase();

async function crawlSource(src, results, seenResults, fetched, stats) {
  const host = bareHost(new URL(src.url).host);
  const queue = [{ url: src.url, prio: Infinity }];
  const queued = new Set([src.url]);
  const budget = src.discovered ? PAGES_PER_DISCOVERED : PAGES_PER_DOMAIN;
  let pages = 0;

  // Posting terbaru dari sitemap.xml (beranda sering hanya berisi "unggulan" lama)
  if (src.sitemap) {
    try {
      const match = src.category === "magang" ? /magang|intern|lowongan/i : null;
      const urls = await recentFromSitemap(new URL(src.url).origin, UA, { limit: budget * 2, match });
      urls.forEach((u, i) => {
        const full = normalize(u);
        if (!full || queued.has(full) || SKIP_EXT.test(new URL(full).pathname)) return;
        queued.add(full);
        queue.push({ url: full, prio: 10 - i / 100, fromSitemap: true });
      });
    } catch (e) {
      console.log(`\n[Sitemap] ${src.url}: ${e.message}`);
    }
  }

  while (
    queue.length &&
    pages < budget &&
    results.length < MAX_RESULTS
  ) {
    queue.sort((a, b) => b.prio - a.prio);
    const { url, fromSitemap } = queue.shift();
    if (fetched.has(url)) continue;
    fetched.add(url);

    const html = await fetchHtml(url);
    pages++;
    await sleep(DELAY_MS);
    if (!html) continue;

    const $ = cheerio.load(html);
    const title = $("h1").first().text().trim() || $("title").text().trim();
    const desc = $('meta[name="description"]').attr("content") || "";
    const paras = $("p")
      .slice(0, 5)
      .map((_, el) => $(el).text().trim())
      .get()
      .join(" ");
    const text = `${title} ${desc} ${paras}`;

    // Situs spam -> buang seluruh sumber
    if (SPAM.test(text) || SPAM.test(url)) return;

    // Halaman dari sitemap / sumber bawaan sering tidak memuat kata kunci di URL
    // (mis. infolomba.id/info-tfest-2026-2208) → pakai kategori sumbernya
    const category =
      classify(`${title} ${url}`) || classify(text) || (fromSitemap || !src.discovered ? src.category : null);

    // Ekstraksi AI → Supabase (halaman listing otomatis dibuang oleh LLM)
    if (category && AI_ENABLED) {
      try {
        await processPage(url, html, stats);
      } catch (e) {
        stats.errors++;
        console.log(`\n[AI] Gagal ${url}: ${e.status || ""} ${e.message}`);
      }
    }

    if (category && title.length > 5 && !seenResults.has(url)) {
      seenResults.add(url);
      results.push({
        category,
        title,
        url,
        snippet: (desc || paras).slice(0, 250) || "Tidak ada deskripsi",
        time: new Date().toISOString(),
      });
    }

    // Ikuti hanya link satu domain yang relevan (lomba/beasiswa/magang)
    $("a[href]").each((_, el) => {
      let full;
      try {
        full = normalize(new URL($(el).attr("href"), url).href);
      } catch {
        return;
      }
      if (!full) return;
      const u = new URL(full);
      if (!/^https?:$/.test(u.protocol) || bareHost(u.host) !== host) return;
      if (SKIP_EXT.test(u.pathname) || fetched.has(full) || queued.has(full)) return;
      const anchor = $(el).text().replace(/\s+/g, " ").trim();
      if (classify(`${anchor} ${full}`)) {
        queued.add(full);
        queue.push({ url: full, prio: linkPriority(full, anchor) });
      }
    });
  }
  return pages;
}

// ---------- Siklus utama ----------
let running = false;
let lastResults = [];
let lastRun = null;

async function runCycle() {
  if (running) return;
  running = true;
  const spinner = ora("Mencari sumber otomatis...").start();
  const startedAt = new Date().toISOString();
  const stats = newStats();
  let note = null;

  try {
    const sources = await discover();
    spinner.text = `Ditemukan ${sources.length} sumber, mulai merayap...`;

    const results = [];
    live = { startedAt, stats, results };
    const seenResults = new Set();
    const fetched = new Set();

    // Jatah halaman dibagi rata per kategori supaya lomba/beasiswa/magang seimbang
    const catCap = Math.ceil(MAX_RESULTS / 3);
    const catPages = { lomba: 0, beasiswa: 0, magang: 0 };
    clearSitemapCache();

    for (const src of sources) {
      if (results.length >= MAX_RESULTS) break;
      if ((catPages[src.category] || 0) >= catCap) continue;
      spinner.text = `Merayap: ${src.url} (${results.length}/${MAX_RESULTS}, AI tersimpan: ${stats.extracted})`;
      const before = stats.extracted;
      catPages[src.category] =
        (catPages[src.category] || 0) + (await crawlSource(src, results, seenResults, fetched, stats));
      try {
        recordSource(src, stats.extracted - before); // pelajari sumber yang produktif
      } catch (e) {
        console.log(`\n[Sources] Gagal menyimpan: ${e.message}`);
      }
    }

    const expired = await expireOld().catch((e) => {
      console.log(`\n[DB] Gagal expire: ${e.message}`);
      return 0;
    });
    note = `expired=${expired}`;
    lastStats = stats;

    lastResults = results;
    lastRun = new Date().toISOString();

    const text = results
      .map(
        (r, i) =>
          `--- [${i + 1}] ${r.category.toUpperCase()} ---\n` +
          `Judul: ${r.title}\nURL: ${r.url}\nWaktu: ${r.time}\nCuplikan: ${r.snippet}\n\n`,
      )
      .join("");
    fs.writeFileSync("results.txt", text, "utf-8");
    fs.writeFileSync("results.json", JSON.stringify(results, null, 2), "utf-8");

    if (results.length)
      spinner.succeed(
        `Selesai: ${results.length} data (results.txt & results.json). ` +
          `AI: ${stats.extracted} tersimpan, ${stats.skipped} dilewati, ${stats.errors} error.`,
      );
    else
      spinner.warn(
        "Tidak ada data. Cek blokir/rate-limit, atau tambahkan API key pencarian.",
      );
  } catch (e) {
    note = `fatal: ${e.message}`;
    spinner.fail(`Error: ${e.message}`);
  } finally {
    await logRun(startedAt, stats, note).catch(() => {});
    running = false;
  }
}

let lastStats = null;
let live = null; // progres siklus yang sedang berjalan

// ---------- Auth helper: verifikasi JWT Supabase dari frontend ----------
async function requireUser(req, res) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ error: "Butuh header Authorization: Bearer <access_token>" });
    return null;
  }
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) {
    res.status(401).json({ error: "Token tidak valid" });
    return null;
  }
  return data.user;
}

// ---------- Server ----------
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => {
  res.json({
    status: running ? "crawling" : "idle",
    lastRun,
    total: lastResults.length,
    ai: { enabled: AI_ENABLED, models: MODEL, lastModelUsed, embeddings: embeddingsEnabled(), lastStats },
    progress:
      running && live
        ? {
            startedAt: live.startedAt,
            elapsedSec: Math.round((Date.now() - new Date(live.startedAt)) / 1000),
            crawled: live.results.length,
            maxResults: MAX_RESULTS,
            ...live.stats, // pages / extracted / skipped / errors sejauh ini
          }
        : null,
    schedule: CRON_SCHEDULE,
  });
});

// Frontend: upload CV ke bucket 'cv' di path "<user_id>/cv.pdf", lalu panggil ini.
app.post("/cv/parse", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cvPath = req.body?.cvPath || `${user.id}/cv.pdf`;
  try {
    const cv = await processCv(user.id, cvPath);
    if (!cv) return res.status(422).json({ error: "CV tidak dapat diproses" });
    res.json(cv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Frontend: panggil setelah user mengisi/mengubah biodata (jurusan, minat).
app.post("/profile/refresh", async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    res.json({ embedded: await refreshProfileEmbedding(user.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "results.html"));
});

// Data BERSIH hasil saringan AI dari Supabase (dipakai /dashboard).
// /results?category=beasiswa   /results?all=1 (ikut tampilkan yang expired)
app.get("/results", async (req, res) => {
  const { category, all } = req.query;
  // Daftar: kolom ringkas saja (detail lengkap diambil per item lewat /opportunities/:id)
  let q = sb
    .from("opportunities")
    .select("id,category,title,organizer,deadline,domains,summary,official_url,source_url,registration_url,status,updated_at")
    .order("updated_at", { ascending: false })
    .limit(500);
  if (!all) q = q.eq("status", "active");
  if (category) q = q.eq("category", category);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map(withLinks));
});

// Detail satu peluang: semua data hasil ekstraksi (tanpa memanggil AI lagi)
app.get("/opportunities/:id", async (req, res) => {
  const { data, error } = await sb
    .from("opportunities")
    .select(
      "id,category,title,organizer,deadline,domains,tags,eligible_levels,eligible_majors,is_general,requirements,summary,registration_url,official_url,source_url,status,scraped_at,updated_at",
    )
    .eq("id", req.params.id)
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: "Tidak ditemukan" });
  res.json(withLinks(data));
});

// Link "detail" = halaman resmi (web/IG/TikTok/FB) → halaman sumber → form (jika tak ada keduanya)
function withLinks(o) {
  return { ...o, url: o.official_url || o.source_url || o.registration_url, time: o.updated_at };
}

// Hasil crawl mentah siklus terakhir (sebelum disaring AI), untuk debug
app.get("/results/raw", (req, res) => {
  const { category } = req.query;
  res.json(category ? lastResults.filter((r) => r.category === category) : lastResults);
});

app.get("/run", (req, res) => {
  if (running) return res.json({ message: "Masih berjalan" });
  runCycle();
  res.json({ message: "Crawler dimulai" });
});

app.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    console.log("[Config] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diisi di .env");
  if (!process.env.GEMINI_API_KEY)
    console.log("[Config] GEMINI_API_KEY belum diisi di .env: ekstraksi AI akan gagal.");
  console.log(`[Cron] Jadwal "${CRON_SCHEDULE}" (Asia/Jakarta), model ${MODEL.join(" → ")}`);

  if (process.env.RUN_ON_START !== "false") runCycle();
  cron.schedule(CRON_SCHEDULE, runCycle, { timezone: "Asia/Jakarta" });
});
