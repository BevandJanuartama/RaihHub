import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS) || 60000;
export const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: TIMEOUT_MS },
});

// Rantai model: dicoba berurutan. Model yang sedang overload (503/429) di-skip sementara.
export const MODELS = (process.env.GEMINI_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.8-flash")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const COOLDOWN_MS = 10 * 60 * 1000;
const cooldownUntil = new Map(); // model -> timestamp
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function candidates() {
  const now = Date.now();
  const ready = MODELS.filter((m) => (cooldownUntil.get(m) || 0) <= now);
  return ready.length ? ready : MODELS; // semua cooldown → coba semuanya lagi
}

export let lastModelUsed = null;

/**
 * generateContent dengan output JSON yang divalidasi skema Zod.
 * Mengembalikan objek hasil parse, atau null kalau model gagal menghasilkan JSON valid.
 */
export async function generateJson({ schema, contents, systemInstruction, attempts = 3 }) {
  const jsonSchema = z.toJSONSchema(schema);
  delete jsonSchema.$schema;

  let lastErr;
  for (let round = 0; round < attempts; round++) {
    for (const model of candidates()) {
      try {
        const res = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchema,
            temperature: 0.1,
          },
        });
        lastModelUsed = model;
        if (!res.text) return null; // diblokir safety / kosong
        const parsed = schema.safeParse(JSON.parse(res.text));
        return parsed.success ? parsed.data : null;
      } catch (e) {
        lastErr = e;
        if (e instanceof SyntaxError) return null; // JSON rusak
        // 400/401/403/404 = kesalahan konfigurasi → jangan diulang.
        // Tanpa status (timeout/jaringan) atau 429/5xx → coba model berikutnya.
        if (e.status && !RETRYABLE.has(e.status)) throw e;
        cooldownUntil.set(model, Date.now() + COOLDOWN_MS);
      }
    }
    await sleep(2000 * 2 ** round); // semua model sibuk → tunggu lalu ulang
  }
  throw lastErr;
}

// ---------- Embedding: gemini-embedding-001, 1024 dimensi (sesuai vector(1024)) ----------
export const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";

export async function embed(texts, kind = "document") {
  const res = await ai.models.embedContent({
    model: EMBED_MODEL,
    contents: texts,
    config: {
      outputDimensionality: 1024,
      taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
    },
  });
  // Dimensi < 3072 tidak ternormalisasi: normalkan agar skor cosine konsisten
  return res.embeddings.map(({ values }) => {
    const n = Math.hypot(...values) || 1;
    return values.map((v) => v / n);
  });
}
