// api/chat.js — Megha AI (OpenAI + Supabase) with solid CORS + SSE
export const config = { api: { bodyParser: false } };

/** ---------- CORS / helpers (keep as-is) ---------- **/
function pickOrigin(req) {
  const list = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const allow = new Set(list.length ? list : ["*"]); // fallback to * if not set
  const o = req.headers?.origin;
  // If "*" allowed, return "*", else echo-matched origin
  return allow.has("*") ? "*" : (o && allow.has(o) ? o : "*");
}

function setCORS(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, x-requested-with, accept, origin"
  );
}

async function readJSON(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { return {}; }
}

/** ---------- Config ---------- **/
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const MAX_CONTEXT_CHUNKS = Number(process.env.MAX_CONTEXT_CHUNKS || 6);
const MAX_DISTANCE = Number(process.env.MAX_DISTANCE || 0.40);

/** Build a compact context block for the model */
function toContext(rows) {
  return (rows || [])
    .map((r, i) => `[#${i + 1}] ${r.url}\n${(r.content || "").slice(0, 800)}`)
    .join("\n\n");
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCORS(res, origin);

  // Preflight
  if (req.method === "OPTIONS") return res.status(204).end();

  // Health (handy in browser)
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "/api/chat", ts: Date.now() });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Parse input
  const body = await readJSON(req);
  const userMessage =
    (typeof body?.message === "string" && body.message) ||
    (Array.isArray(body?.messages) && body.messages.at(-1)?.content) ||
    "";

  if (!userMessage) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: "Missing 'message' in body" })}\n\n`);
    return res.end();
  }

  // Lazy-load deps to avoid module-type issues
  const [{ default: OpenAI }, { createClient }] = await Promise.all([
    import("openai"),
    import("@supabase/supabase-js"),
  ]);

  // Env checks
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: "Missing env: OPENAI_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_KEY" })}\n\n`);
    return res.end();
  }

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // 1) Embed query
    const emb = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: userMessage,
    });
    const qVec = emb.data[0].embedding;

    // 2) Retrieve top chunks via RPC
    const { data: rows, error: rpcError } = await supabase.rpc("match_web_chunks", {
      query_embedding: qVec,
      match_count: MAX_CONTEXT_CHUNKS,
      max_distance: MAX_DISTANCE,
    });
    if (rpcError) throw new Error(`Supabase RPC error: ${rpcError.message}`);

    // 3) Build messages (grounded)
    const contextText = toContext(rows);
    const messages = [
      {
        role: "system",
        content:
`You are Megha, Megaska's friendly shopping assistant.
Use ONLY the CONTEXT (from megaska.com). If unsure, say you're not fully sure based on site data and suggest where to look (collections, product page, size guide, returns).
Be concise and helpful; use bullets for sizes/specs.`,
      },
      { role: "system", content: `CONTEXT:\n${contextText || "(no relevant context found)"}` },
      { role: "user", content: userMessage },
    ];

    // 4) Stream completion to the widget (expects {output_text})
    const stream = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      stream: true,
      messages,
    });

    for await (const part of stream) {
      const delta = part?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length) {
        res.write(`data: ${JSON.stringify({ output_text: delta })}\n\n`);
      }
    }

    // 5) Send cited sources
    res.write(
      `event: sources\ndata: ${JSON.stringify(
        (rows || []).map((r) => ({ url: r.url, chunk_index: r.chunk_index }))
      )}\n\n`
    );

    // 6) Close stream
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (e) {
    console.error("MEGHA_CHAT_ERROR", {
      message: e?.message,
      stack: e?.stack,
      from: req.headers?.origin,
      ua: req.headers?.["user-agent"],
    });
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message || "Internal error" })}\n\n`);
      res.end();
    } catch {
      // If SSE failed mid-flight
      res.status(500).json({ error: e?.message || "Internal error" });
    }
  }
}
