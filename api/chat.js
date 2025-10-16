// api/chat.js — Megha AI with immediate first-token + timeouts + loud errors (v: ai-v2)
export const config = { api: { bodyParser: false } };

// ---------- CORS + helpers ----------
function setCORS(res, origin = "*") {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, x-requested-with, accept, origin"
  );
  res.setHeader("Access-Control-Max-Age", "600");
}
function pickOrigin(/*req*/) { return "*"; }

async function readJSON(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { return {}; }
}

// small timeout helper
async function withTimeout(promise, ms, label) {
  let to;
  const timeout = new Promise((_, rej) => {
    to = setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try {
    const v = await Promise.race([promise, timeout]);
    clearTimeout(to);
    return v;
  } catch (e) {
    clearTimeout(to);
    throw e;
  }
}

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCORS(res, origin);

  // Preflight
  if (req.method === "OPTIONS") return res.status(200).end();

  // Health
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "/api/chat", version: "ai-v2", ts: Date.now() });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // SSE headers FIRST, so even errors are visible
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Read input
  const body = await readJSON(req);
  const userMessage =
    (typeof body?.message === "string" && body.message) ||
    (Array.isArray(body?.messages) && body.messages.at(-1)?.content) ||
    "";

  if (!userMessage) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: "Missing 'message' in body" })}\n\n`);
    return res.end();
  }

  // STUB switch if needed (keeps site live while testing)
  if ((process.env.MEGHA_MODE || "").toLowerCase() === "stub") {
    res.write(`data: ${JSON.stringify({ output_text: "Hi! Megha is online. " })}\n\n`);
    res.write(`data: ${JSON.stringify({ output_text: "Ready to help." })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    return res.end();
  }

  // Immediately send a tiny token so the UI stops “infinite typing”
  res.write(`data: ${JSON.stringify({ output_text: "Got it — thinking… " })}\n\n`);

  // Watchdog: if nothing else is emitted in 10s, inform user
  let emittedMore = false;
  const watchdog = setTimeout(() => {
    if (!emittedMore) {
      res.write(`data: ${JSON.stringify({ output_text: "\n(Still working… fetching site info) " })}\n\n`);
    }
  }, 10000);
// (A) right after reading userMessage, keep your immediate token:
res.write(`data: ${JSON.stringify({ output_text: "Got it — thinking… " })}\n\n`);

try {
  const [{ default: OpenAI }, { createClient }] = await Promise.all([
    import("openai"),
    import("@supabase/supabase-js"),
  ]);

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Missing env: OPENAI_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_KEY");
  }

  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const MAX_CONTEXT_CHUNKS = Number(process.env.MAX_CONTEXT_CHUNKS || 6);
  const MAX_DISTANCE = Number(process.env.MAX_DISTANCE || 0.4);

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // (B) allow skipping parts via env flags
  const SKIP_SB = (process.env.MEGHA_SKIP_SUPABASE || "") === "1";
  const SKIP_OAI = (process.env.MEGHA_SKIP_OPENAI || "") === "1";

  // 1) Embed (unless skipping OpenAI entirely)
  let qVec = null;
  if (!SKIP_OAI) {
    const emb = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: userMessage,
    });
    qVec = emb.data[0].embedding;
  }

  // 2) Retrieve chunks (unless skipping Supabase)
  let rows = [];
  if (!SKIP_SB && qVec) {
    const { data, error } = await supabase.rpc("match_web_chunks", {
      query_embedding: qVec,
      match_count: MAX_CONTEXT_CHUNKS,
      max_distance: MAX_DISTANCE,
    });
    if (error) throw new Error(`Supabase RPC error: ${error.message}`);
    rows = data || [];
  }

  // If SKIP_OPENAI=1, just summarize matched chunks and finish (debug mode)
  if (SKIP_OAI) {
    const preview = (rows || []).slice(0, 3).map(r => `• ${r.url}`).join("\n");
    res.write(`data: ${JSON.stringify({ output_text: "Found site references:\n" + (preview || "(none)") })}\n\n`);
    res.write(`event: sources\ndata: ${JSON.stringify((rows || []).map(r => ({ url: r.url, chunk_index: r.chunk_index })))}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    return res.end();
  }

  // 3) Prompt + stream from OpenAI
  const contextText = (rows || [])
    .map((r, i) => `[#${i + 1}] ${r.url}\n${(r.content || "").slice(0, 800)}`)
    .join("\n\n");
  const messages = [
    { role: "system", content:
`You are Megha, Megaska's friendly shopping assistant.
Use ONLY the CONTEXT (from megaska.com). If unsure, say so and guide the user (collections, product page, size guide, returns).
Be concise and practical; use bullets for sizes/policies when helpful.` },
    { role: "system", content: `CONTEXT:\n${contextText || "(no relevant context found)"}` },
    { role: "user", content: userMessage },
  ];

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

  res.write(`event: sources\ndata: ${JSON.stringify((rows || []).map(r => ({ url: r.url, chunk_index: r.chunk_index })))}\n\n`);
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
} catch (e) {
  console.error("MEGHA_CHAT_ERROR", { message: e?.message, stack: e?.stack });
  try {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message || "Internal error" })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch {
    res.status(500).json({ error: e?.message || "Internal error" });
  }
}

 
  
  
  
  try {
    // Lazy imports (avoid top-level crashes)
    const [{ default: OpenAI }, { createClient }] = await Promise.all([
      import("openai"),
      import("@supabase/supabase-js"),
    ]);

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    if (!OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error("Missing env: OPENAI_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_KEY");
    }

    const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
    const MAX_CONTEXT_CHUNKS = Number(process.env.MAX_CONTEXT_CHUNKS || 6);
    const MAX_DISTANCE = Number(process.env.MAX_DISTANCE || 0.4);

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1) Embed (with timeout)
    const emb = await withTimeout(
      openai.embeddings.create({ model: EMBEDDING_MODEL, input: userMessage }),
      12000,
      "OpenAI embeddings"
    );
    const qVec = emb.data[0].embedding;

    // 2) Retrieve chunks (with timeout). If RPC fails, continue with no context.
    let rows = [];
    try {
      const { data, error } = await withTimeout(
        supabase.rpc("match_web_chunks", {
          query_embedding: qVec,
          match_count: MAX_CONTEXT_CHUNKS,
          max_distance: MAX_DISTANCE,
        }),
        8000,
        "Supabase RPC"
      );
      if (error) throw new Error(error.message);
      rows = data || [];
    } catch (rpcErr) {
      res.write(`data: ${JSON.stringify({ output_text: "\n(Note: using minimal context) " })}\n\n`);
    }
    emittedMore = true;

    // 3) Prompt
    const contextText = (rows || [])
      .map((r, i) => `[#${i + 1}] ${r.url}\n${(r.content || "").slice(0, 800)}`)
      .join("\n\n");
    const messages = [
      {
        role: "system",
        content:
`You are Megha, Megaska's friendly shopping assistant.
Use ONLY the CONTEXT (from megaska.com). If unsure, say so and guide the user (collections, product page, size guide, returns).
Be concise and practical; use bullets for sizes/policies when helpful.`,
      },
      { role: "system", content: `CONTEXT:\n${contextText || "(no relevant context found)"}` },
      { role: "user", content: userMessage },
    ];

    // 4) Stream completion (with timeout). If model stalls, inform user.
    const stream = await withTimeout(
      openai.chat.completions.create({ model: MODEL, temperature: 0.2, stream: true, messages }),
      15000,
      "OpenAI chat"
    );

    for await (const part of stream) {
      const delta = part?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length) {
        emittedMore = true;
        res.write(`data: ${JSON.stringify({ output_text: delta })}\n\n`);
      }
    }

    // 5) Sources + done
    res.write(
      `event: sources\ndata: ${JSON.stringify(
        (rows || []).map((r) => ({ url: r.url, chunk_index: r.chunk_index }))
      )}\n\n`
    );
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    clearTimeout(watchdog);
    res.end();
  } catch (e) {
    clearTimeout(watchdog);
    console.error("MEGHA_CHAT_ERROR", { message: e?.message, stack: e?.stack });
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message || "Internal error" })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch {
      res.status(500).json({ error: e?.message || "Internal error" });
    }
  }
}
