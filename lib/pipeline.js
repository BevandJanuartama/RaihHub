import { sb } from "./supabase.js";
import { cleanHtml, extractOpportunity, parseCv, NEWS_TITLE_RE } from "./extract.js";

const OPEN_CALL_RE = /pendaftaran|dibuka|open registration|open recruitment|call for|deadline|batas akhir|lowongan|syarat|cara daftar/i;
import { embed } from "./embed.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// "Halaman resmi" yang ternyata situs agregator itu sendiri bukan halaman resmi
function officialUrl(u, sourceUrl) {
  const v = validUrl(u);
  if (!v) return null;
  const bare = (x) => new URL(x).host.replace(/^www\./, "");
  return bare(v) === bare(sourceUrl) ? null : v;
}

function validUrl(u) {
  try {
    return u && /^https?:$/.test(new URL(u).protocol) ? u : null;
  } catch {
    return null;
  }
}

export function newStats() {
  return { pages: 0, extracted: 0, skipped: 0, errors: 0, removed: 0, reasons: {} };
}

function skip(stats, reason) {
  stats.skipped++;
  stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
  return null;
}

// Halaman yang dulu tersimpan tapi sekarang dinilai bukan peluang → hapus dari DB
async function removeIfExists(url, existing, stats) {
  if (!existing) return;
  const { error } = await sb.from("opportunities").delete().eq("source_url", url);
  if (!error) stats.removed++;
}

/**
 * Proses satu halaman: clean → dedup → ekstraksi AI → embedding → upsert.
 * Mengembalikan baris yang disimpan, atau null bila dilewati.
 */
export async function processPage(url, html, stats) {
  stats.pages++;
  const { title, text, links, hash } = cleanHtml(html, url);

  const { data: existing, error: selErr } = await sb
    .from("opportunities")
    .select("content_hash")
    .eq("source_url", url)
    .maybeSingle();
  if (selErr) throw selErr;

  if (text.length < 300) return skip(stats, "teks_pendek");

  // Berita juara/prestasi yang jelas → buang tanpa memanggil LLM
  if (NEWS_TITLE_RE.test(title) && !OPEN_CALL_RE.test(title)) {
    await removeIfExists(url, existing, stats);
    return skip(stats, "berita_prestasi");
  }

  // Dedup: konten tidak berubah sejak scraping terakhir → tidak perlu panggil LLM lagi
  if (existing?.content_hash === hash) return skip(stats, "tidak_berubah");

  const result = await extractOpportunity({ url, text, links });
  if (!result.ok) {
    await removeIfExists(url, existing, stats);
    return skip(stats, result.reason);
  }
  const opp = result.data;

  // Sudah lewat: deadline sebelum hari ini, atau tanpa deadline tapi semua tahun yang
  // disebut (URL/judul) sudah lampau, mis. lowongan /2025/06/ yang dibaca Nov 2026
  const today = new Date().toISOString().slice(0, 10);
  const years = `${url} ${opp.title}`.match(/20\d{2}/g)?.map(Number) || [];
  const stale =
    (DATE_RE.test(opp.deadline ?? "") && opp.deadline < today) ||
    (!opp.deadline && years.length > 0 && Math.max(...years) < new Date().getFullYear());
  if (stale) {
    await removeIfExists(url, existing, stats);
    return skip(stats, "kedaluwarsa");
  }

  // Untuk siswa sekolah, bukan mahasiswa (Gemini kadang tetap meloloskan)
  const levels = opp.eligible_levels || [];
  if (
    levels.length === 0 &&
    /\b(beasiswa|sekolah|masuk|pendaftaran)\s+(sd|smp|sma|smk|mts|ma)\b|\blulusan\s+(sd|smp|mts)\b|\bsiswa\s+(sd|smp|sma|smk)\b/i.test(
      `${opp.title} ${opp.requirements.join(" ")}`,
    ) &&
    !/mahasiswa|kuliah|perguruan tinggi|\bs1\b|diploma|sarjana/i.test(opp.title)
  ) {
    await removeIfExists(url, existing, stats);
    return skip(stats, "bukan_mahasiswa");
  }

  // Duplikat: peluang yang sama dari URL lain (judul + penyelenggara sama)
  const { data: dup } = await sb
    .from("opportunities")
    .select("id")
    .ilike("title", opp.title.replace(/[%_]/g, ""))
    .neq("source_url", url)
    .limit(1);
  if (dup?.length) {
    await removeIfExists(url, existing, stats);
    return skip(stats, "duplikat");
  }

  const [embedding] = await embed([
    `${opp.title}. Kategori: ${opp.category}. Bidang: ${opp.domains.join(", ")}. ` +
      `Tag: ${opp.tags.join(", ")}. ${opp.summary}`,
  ]);

  const { page_type, has_registration_info, ...fields } = opp;
  const row = {
    ...fields,
    tags: [...new Set(fields.tags.map((t) => t.toLowerCase().trim()))],
    deadline: DATE_RE.test(fields.deadline ?? "") ? fields.deadline : null,
    registration_url: validUrl(fields.registration_url),
    official_url: officialUrl(fields.official_url, url),
    source_url: url,
    content_hash: hash,
    embedding,
    status: "active",
    scraped_at: new Date().toISOString(),
  };

  const { error } = await sb.from("opportunities").upsert(row, { onConflict: "source_url" });
  if (error) throw error;
  stats.extracted++;
  return row;
}

export async function expireOld() {
  const { data, error } = await sb.rpc("expire_opportunities");
  if (error) throw error;
  return data;
}

export async function logRun(startedAt, stats, note) {
  const { error } = await sb.from("scrape_runs").insert({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    pages: stats.pages,
    extracted: stats.extracted,
    skipped: stats.skipped,
    errors: stats.errors,
    removed: stats.removed,
    reasons: stats.reasons,
    note,
  });
  if (error) console.log(`\n[DB] Gagal mencatat scrape_runs: ${error.message}`);
}

/** Parse CV milik user lalu perbarui profil + embedding profil. */
export async function processCv(userId, cvPath) {
  if (!cvPath.startsWith(`${userId}/`)) throw new Error("cv_path harus berada di folder milik user");

  const { data: file, error: dlErr } = await sb.storage.from("cv").download(cvPath);
  if (dlErr) throw dlErr;
  const cv = await parseCv(Buffer.from(await file.arrayBuffer()));
  if (!cv) return null;

  const { data: p, error: pErr } = await sb
    .from("profiles")
    .select("major, interests")
    .eq("id", userId)
    .single();
  if (pErr) throw pErr;

  const [embedding] = await embed(
    [`Jurusan ${p.major}. Minat: ${p.interests.join(", ")}. Skills: ${cv.skills.join(", ")}. ${cv.summary}`],
    "query",
  );

  const { error } = await sb
    .from("profiles")
    .update({
      cv_path: cvPath,
      cv_skills: [...new Set(cv.skills.map((s) => s.toLowerCase().trim()))],
      cv_domains: cv.domains,
      cv_summary: cv.summary,
      embedding,
    })
    .eq("id", userId);
  if (error) throw error;
  return cv;
}

/** Buat/perbarui embedding profil dari biodata saja (user tanpa CV). */
export async function refreshProfileEmbedding(userId) {
  const { data: p, error } = await sb
    .from("profiles")
    .select("major, interests, cv_skills, cv_summary")
    .eq("id", userId)
    .single();
  if (error) throw error;
  const [embedding] = await embed(
    [
      `Jurusan ${p.major}. Minat: ${p.interests.join(", ")}.` +
        (p.cv_skills.length ? ` Skills: ${p.cv_skills.join(", ")}.` : "") +
        (p.cv_summary ? ` ${p.cv_summary}` : ""),
    ],
    "query",
  );
  if (embedding) await sb.from("profiles").update({ embedding }).eq("id", userId);
  return Boolean(embedding);
}
