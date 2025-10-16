// api/chat.js
import "dotenv/config";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// --- ENV ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service key preferred for RPC
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const MAX_CONTEXT_CHUNKS = Number(process.env.MAX_CONTEXT_CHUNKS || 6);
const MAX_DISTANCE = Number(process.env.MAX_DISTANCE || 0.40);
const ALLOWED = new Set((process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
);

// --- Clients ---
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export const config = {
  api: {
    bodyParser: false, // we’ll parse manually to support streaming
  },
};

// tiny helper to read raw body as text/json
async function readJSON(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const txt = Buffer.concat(chunks).toString("utf8") || "{}";
  try { return JSON.parse(txt); } catch { return {}; }
}

function pickOrigin(req) {
  const o = req.headers.origin;
  return (o && ALLOWED.has(o)) ? o : "*";
}

function setSSEHeaders(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
}

async function embed(text) {
  const r = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return r.data[0].embedding;
}

/**
 * Retrieve top-k chunks via RPC match_web_chunks(query_embedding, match_count, max_distance)
 * If the function doesn’t exist, we throw with a clear message.
 */
async function retrieve(embedding, k = MAX_CONTEXT_CHUNKS, maxDist = MAX_DISTANCE) {
  // Supabase RPC expects plain arrays for vector arguments; pgvector casting happens server-side.
  const { data, error } = await supabase.rpc("match_web_chunks", {
    query_embedding: embedding,
    match_count: k,
    max_distance: maxDist
  });

  if (error) {
    throw new Error(
      `Supabase RPC error: ${error.message}. ` +
      `If this is "function does not exist", run the SQL to create it (match_web_chunks).`
    );
  }
  return data || [];
}

function buildContextRows(rows) {
  return rows.map((r, i) =>
    `[#${i + 1}] ${r.url}\n${(r.content || "").slice(0, 800)}`
  ).join("\n\n");
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  // Safety checks
  if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.status(500).json({ error: "Missing required env: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY" });
    return;
  }

  // Parse input
  const body = await readJSON(req);
  // Accept either {message: "..."} or {messages: [{role, content}...]}
  let userMessage = body?.message;
  let thread = body?.messages;

  if (!userMessage && Array.isArray(thread) && thread.length) {
    userMessage = thread[thread.length - 1]?.content || "";
  }
  if (typeof userMessage !== "string" || !userMessage.trim()) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.status(400).json({ error: "Missing 'message' or 'messages' in request body" });
    return;
  }

  try {
    // Prepare SSE
    setSSEHeaders(res, origin);
    // Tell client stream is starting
    res.write(`event: open\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    // 1) Embed query
    const qEmbedding = await embed(userMessage);

    // 2) Retrieve top chunks from Supabase
    const rows = await retrieve(qEmbedding, MAX_CONTEXT_CHUNKS, MAX_DISTANCE);
    const contextText = buildContextRows(rows);

    // 3) Build messages
    const systemMsg = {
      role: "system",
      content:
`You are Megha, Megaska's friendly shopping assistant.
Answer ONLY using the "CONTEXT" below (which is extracted from megaska.com). 
Be concise, helpful, and accurate. If the answer isn't in context, say "I’m not fully sure based on the site data" and suggest where to look on the site (collections, product page, size guide, returns, etc). 
Prefer bullet points for specs/sizing.`
    };
    const contextMsg = { role: "system", content: `CONTEXT:\n${contextText || "(no relevant context found)"}` };
    const userMsg = { role: "user", content: userMessage };

    const messages = Array.isArray(thread) && thread.length
      ? [systemMsg, contextMsg, ...thread, userMsg] // keep their earlier conversation if provided
      : [systemMsg, contextMsg, userMsg];

    // 4) Stream completion
    const stream = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      stream: true,
      messages
    });

    for await (const part of stream) {
+   const delta = part?.choices?.[0]?.delta?.content;
+   if (typeof delta === "string" && delta.length) {
+     // match the widget's expected key
+     res.write(`data: ${JSON.stringify({ output_text: delta })}\n\n`);
+   }
+ }

    // 5) Send sources and close
    res.write(`event: sources\ndata: ${JSON.stringify(rows.map(r => ({
      url: r.url, chunk_index: r.chunk_index
    })))}\n\n`);

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    // Stream-friendly error
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
    } catch {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.status(500).json({ error: e.message });
    }
  }
}
