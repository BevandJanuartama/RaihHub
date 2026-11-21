// Ambil URL posting terbaru dari sitemap.xml sebuah situs (WordPress, Blogger, dll).
// Jauh lebih andal daripada link di beranda, yang sering cuma berisi "unggulan" lama.
import axios from "axios";

const cache = new Map(); // origin -> Promise<[{url, lastmod, n}]>

async function getXml(url, ua) {
  const { data } = await axios.get(url, {
    timeout: 15000,
    responseType: "text",
    maxContentLength: 15_000_000,
    headers: { "User-Agent": ua },
  });
  return String(data);
}

function parse(xml) {
  const entries = [];
  for (const m of xml.matchAll(/<(url|sitemap)>([\s\S]*?)<\/\1>/g)) {
    const loc = m[2].match(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)/)?.[1];
    const lastmod = m[2].match(/<lastmod>\s*([^<\s]+)/)?.[1] || "";
    if (loc) entries.push({ url: loc.replace(/&amp;/g, "&"), lastmod });
  }
  return { isIndex: /<sitemapindex/i.test(xml), entries };
}

async function load(origin, ua) {
  // Sitemap dari robots.txt, lalu lokasi umum
  const candidates = [];
  try {
    const robots = await getXml(`${origin}/robots.txt`, ua);
    for (const m of robots.matchAll(/^sitemap:\s*(\S+)/gim)) candidates.push(m[1]);
  } catch {}
  candidates.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`);

  for (const sm of [...new Set(candidates)]) {
    try {
      let { isIndex, entries } = parse(await getXml(sm, ua));
      if (isIndex) {
        // Indeks: buka sub-sitemap posting yang paling baru (maks 2)
        const subs = entries
          .filter((e) => !/tag|category|author|page-sitemap|attachment/i.test(e.url))
          .sort((a, b) => (b.lastmod || "").localeCompare(a.lastmod || "") || /post/i.test(b.url) - /post/i.test(a.url))
          .slice(0, 2);
        entries = [];
        for (const s of subs) {
          try {
            entries.push(...parse(await getXml(s.url, ua)).entries);
          } catch {}
        }
      }
      if (entries.length) {
        return entries.map((e) => ({ ...e, n: Number(e.url.match(/(\d+)(?:\.html)?\/?$/)?.[1] || 0) }));
      }
    } catch {}
  }
  return [];
}

/**
 * URL terbaru dari sitemap situs `origin`.
 * Urut: lastmod terbaru, lalu angka ID di akhir URL (mis. /info-xxx-2208) yang lebih besar.
 */
export async function recentFromSitemap(origin, ua, { limit = 15, match = null } = {}) {
  if (!cache.has(origin)) cache.set(origin, load(origin, ua));
  const all = await cache.get(origin);
  return all
    .filter((e) => {
      const p = new URL(e.url).pathname;
      return p.length > 1 && !/\/(tag|category|kategori|author|page)\//i.test(p) && (!match || match.test(e.url));
    })
    .sort((a, b) => (b.lastmod || "").localeCompare(a.lastmod || "") || b.n - a.n)
    .slice(0, limit)
    .map((e) => e.url);
}

export function clearSitemapCache() {
  cache.clear();
}
