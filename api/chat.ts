import "dotenv/config";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const MAX_CONTEXT_CHUNKS = Number(process.env.MAX_CONTEXT_CHUNKS || 6);
const MAX_DISTANCE = Number(process.env.MAX_DISTANCE || 0.40);

export const config = { api: { bodyParser: false } };

async function readJSON(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { return {}; }
}
function pickOrigin(req) {
  const allowed = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean));
  const o = req.headers.origin;
  return (o && allowed.has(o)) ? o : "*";
}
async function embed(text) {
  const r = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  return r.data[0].embedding;
}
async function retrieve(embedding, k = MAX_CONTEXT_CHUNKS, maxDist = MAX_DISTANCE) {
  const { data, error } = await supabase.rpc("match_web_chunks", {
    query_embedding: embedding,
    match_count: k,
    max_distance: maxDist
  });
  if (error) throw new Error(`Supabase RPC error: ${error.message}`);
  return data || [];
}
function toContext(rows) {
  return rows.map((r,i)=>`[#${i+1}] ${r.url}\n${(r.content||"").slice(0,800)}`).join("\n\n");
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const body = await readJSON(req);
  const userMessage = (body?.message || (Array.isArray(body?.messages) && body.messages.at(-1)?.content) || "").toString().trim();
  if (!userMessage) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    return res.status(400).json({ error: "Missing message" });
  }

  // SSE headers
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  try {
    const qEmbedding = await embed(userMessage);
    const rows = await retrieve(qEmbedding);
    const contextText = toContext(rows);

    const messages = [
      { role: "system", content:
`You are Megha, Megaska's shopping assistant. Use only the CONTEXT (from megaska.com).
If unsure, say so and suggest where to look on the site (collections, product page, size guide, returns). Be concise.` },
      { role: "system", content: `CONTEXT:\n${contextText || "(no relevant context found)"}` },
      { role: "user", content: userMessage }
    ];

    const stream = await openai.chat.completions.create({
      model: MODEL, temperature: 0.2, stream: true, messages
    });

    for await (const part of stream) {
      const delta = part?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length) {
        // IMPORTANT: your widget expects "output_text"
        res.write(`data: ${JSON.stringify({ output_text: delta })}\n\n`);
      }
    }
    res.write(`event: sources\ndata: ${JSON.stringify(rows.map(r=>({url:r.url, chunk_index:r.chunk_index})))}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
}
