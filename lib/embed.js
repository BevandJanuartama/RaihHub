// Embedding memakai Gemini (key yang sama dengan ekstraksi). Lihat lib/gemini.js.
import { embed as geminiEmbed } from "./gemini.js";

export const embeddingsEnabled = () => Boolean(process.env.GEMINI_API_KEY) && process.env.EMBEDDINGS !== "off";

/** Kembalikan array vektor; null per item bila embedding mati/gagal (feed tetap jalan via tag scoring). */
export async function embed(texts, kind = "document") {
  if (!embeddingsEnabled()) return texts.map(() => null);
  try {
    return await geminiEmbed(texts, kind);
  } catch (e) {
    console.log(`\n[Embed] Gagal: ${e.status || ""} ${String(e.message).slice(0, 120)}`);
    return texts.map(() => null);
  }
}
