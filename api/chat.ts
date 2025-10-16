// api/chat.ts
import "dotenv/config";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// ---- ENV ----
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const MAX_CONTEXT_CHUNKS = Number(process.env.MAX_CONTEXT_CHUNKS || 6);
const MAX_DISTANCE = Number(process.env.MAX_DISTANCE || 0.40);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Vercel Node API config: disable body parsing so we can stream
export const config = {
  api: {
    bodyParser: false,
  },
};

// ----- helpers -----
function pickOrigin(req: any) {
  const allowList = new Set(
    (process.env.ALLOWED_ORIGINS || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
  );
  const o = req.headers?.origin as string | undefined;
  return (o && allowList.has(o)) ? o : "*";
}

function setCORS(res: any, origin: string) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, x-requested-with, accept, origin"
  );
}

async function readJSON(req: any) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const txt = Buffer.concat(chunks).toString("utf8") || "{}";
  try { return JSON.parse(txt); } catch { return {}; }
}

async function embed(text: string) {
  const r = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return r.data[0].embedding;
}

async function retrieve(embedding: number[], k = MAX_CONTEXT_CHUNKS, maxDist = MAX_DISTANCE) {
  // RPC: match_web_chunks(query_embedding vector, match_count int, max_distance float)
  const { data, error } = await supabase.rpc("match_web_chunks", {
    query_embedding: embedding,
    match_count: k,
    max_distance: maxDist
  });
  if (error) throw new Error(`Supabase RPC error: ${error.message}`);
  return (data || []) as Array<{ url: string; chunk_index: number; content: string }>;
}

function toContext(rows: Array<{url: string; chunk_index: number; content: string}>) {
  return rows
    .map((r, i) => `[#${i + 1}] ${r.url}\n${(r.content || "").slice(0, 800)}`)
    .join("\n\n");
}

// ----- handler -----
export default async function handler(req: any, res: any) {
  const origin = pickOrigin(req);
  setCORS(res, origin);

  // Preflight (CORS)
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: "Missing required env vars" });
  }

  // Parse input
  const body = await readJSON(req);
  const userMessage =
    (typeof body?.message === "string" && body.message) ||
    (Array.isArray(body?.messages) && body.messages.at(-1)?.content) ||
    "";

  if (!userMessage || typeof userMessage !== "string") {
    return res.status(400).json({ error: "Missing 'message' (string) in request body" });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  try {
    // 1) Embed & retrieve context
    const qEmb = await embed(userMessage);
    const rows = await retrieve(qEmb);
    const contextText = toContext(rows);

    // 2) Build prompt
    const messages = [
      {
        role: "system",
        content:
`You are Megha, Megaska's friendly shopping assistant.
Use ONLY the CONTEXT below (from megaska.com). If something isn't covered, say you aren't fully sure and suggest where to look (collections, product page, size guide, returns). Be concise and helpful.`
      },
      { role: "system", content: `CONTEXT:\n${contextText || "(no relevant context found)"}` },
      { role: "user", content: userMessage }
    ];

    // 3) Stream completion; IMPORTANT: use "output_text" for the widget
    const stream = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      stream: true,
      messages
    });

    for await (const part of stream as any) {
      const delta = part?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length) {
        res.write(`data: ${JSON.stringify({ output_text: delta })}\n\n`);
      }
    }

    // 4) Send sources + close
    res.write(`event: sources\ndata: ${JSON.stringify(rows.map(r => ({ url: r.url, chunk_index: r.chunk_index })))}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e: any) {
    console.error("CHAT_ERROR", {
      message: e?.message,
      stack: e?.stack,
      from: req.headers?.origin,
      ua: req.headers?.["user-agent"]
    });
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message || "Internal error" })}\n\n`);
      res.end();
    } catch {
      res.status(500).json({ error: e?.message || "Internal error" });
    }
  }
}
