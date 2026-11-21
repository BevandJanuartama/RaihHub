// Sumber crawling: daftar bawaan (sudah diverifikasi) + sumber yang dipelajari otomatis.
// Situs hasil pencarian yang terbukti menghasilkan peluang disimpan ke data/sources.json
// dan dipakai lagi di siklus berikutnya. Sumber yang 3 siklus berturut-turut kosong dibuang.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, "..", "data", "sources.json");
const MAX_MISSES = 3;

// Diverifikasi bisa diakses, masih aktif update, dan berisi info peluang (21 Nov 2026).
// Dibuang: schoters (link "daftar" = form konsultasi agen), beasiswaindo & infomagang
// (tidak update sejak 2025), magang.id (situs JavaScript), kreativitas.ugm (berita prestasi).
// sitemap: true → ambil posting terbaru dari sitemap.xml, bukan hanya link di beranda.
export const BUILTIN_SOURCES = [
  { url: "https://infolomba.id/", category: "lomba", sitemap: true },
  { url: "https://www.kompetisi.co.id/", category: "lomba", sitemap: true },
  { url: "https://www.infolombait.com/", category: "lomba", sitemap: true },
  { url: "https://indbeasiswa.com/", category: "beasiswa", sitemap: true },
  { url: "https://www.luarkampus.id/", category: "beasiswa" },
  { url: "https://lpdp.kemenkeu.go.id/", category: "beasiswa" },
  { url: "https://indbeasiswa.com/category/lowongan-magang/", category: "magang", sitemap: true },
  { url: "https://maganghub.kemnaker.go.id/", category: "magang" },
  { url: "https://www.kalibrr.id/id-ID/home/i/internship", category: "magang" },
];

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch {
    return {}; // belum ada / rusak → mulai kosong
  }
}

function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2), "utf-8");
}

/** Sumber yang dipelajari dari siklus sebelumnya. */
export function learnedSources() {
  return Object.entries(load()).map(([url, s]) => ({ url, category: s.category, learned: true }));
}

/**
 * Catat hasil satu sumber setelah dirayapi.
 * - Sumber hasil pencarian yang menghasilkan peluang → disimpan sebagai beranda domainnya.
 * - Sumber yang dipelajari tapi kosong → hitung miss, buang setelah MAX_MISSES.
 */
export function recordSource(src, extracted) {
  const db = load();
  if (src.discovered && extracted > 0) {
    const home = new URL(src.url).origin + "/";
    if (!BUILTIN_SOURCES.some((b) => new URL(b.url).origin + "/" === home)) {
      const cur = db[home] || { category: src.category, extracted: 0, misses: 0, addedAt: new Date().toISOString() };
      cur.extracted += extracted;
      cur.misses = 0;
      cur.lastHit = new Date().toISOString();
      db[home] = cur;
    }
  } else if (src.learned) {
    const cur = db[src.url];
    if (cur) {
      if (extracted > 0) {
        cur.extracted += extracted;
        cur.misses = 0;
        cur.lastHit = new Date().toISOString();
      } else if (++cur.misses >= MAX_MISSES) {
        delete db[src.url];
      }
    }
  }
  save(db);
}

/** Susun sumber selang-seling per kategori supaya lomba/beasiswa/magang sama-sama kebagian. */
export function interleave(sources) {
  const seen = new Set();
  const byCat = {};
  for (const s of sources) {
    if (seen.has(s.url)) continue;
    seen.add(s.url);
    (byCat[s.category] ||= []).push(s);
  }
  const lists = Object.values(byCat);
  const out = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) if (l[i]) out.push(l[i]);
  }
  return out;
}
