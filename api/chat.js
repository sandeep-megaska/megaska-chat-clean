// api/chat.js — Megha AI with stub fallback + loud error events
export const config = { api: { bodyParser: false } };

// ... keep pickOrigin, setCORS, readJSON, toContext, MODEL consts as you have ...

export default async function handler(req, res) {
  const origin = pickOrigin(req);
  setCORS(res, origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, route: "/api/chat", ts: Date.now() });
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // SSE headers early so even errors are visible to browser
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const body = await readJSON(req);
  const userMessage =
    (typeof body?.message === "string" && body.message) ||
    (Array.isArray(body?.messages) && body.messages.at(-1)?.content) || "";

  if (!userMessage) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: "Missing 'message' in body" })}\n\n`);
    return res.end();
  }

  // 🔁 Stub fallback for live testing
  if ((process.env.MEGHA_MODE || "").toLowerCase() === "stub") {
    res.write(`data: ${JSON.stringify({ output_text: "Hi! Megha is online. " })}\n\n`);
    res.write(`data: ${JSON.stringify({ output_text: "Ready to help." })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    return res.end();
  }

  try {
    // Lazy imports (prevent top-level crashes)
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

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1) Embed
    const emb = await openai.embeddings.create({
      model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
      input: userMessage,
    });
    const qVec = emb.data[0].embedding;

    // 2) Retrieve via RPC
    const { data: rows, error: rpcError } = await supabase.rpc("match_web_chunks", {
      query_embedding: qVec,
      match_count: Number(process.env.MAX_CONTEXT_CHUNKS || 6),
      max_distance: Number(process.env.MAX_DISTANCE || 0.4),
    });
    if (rpcError) throw new Error(`Supabase RPC error: ${rpcError.message}`);

    // 3) Prompt
    const contextText = (rows || [])
      .map((r, i) => `[#${i + 1}] ${r.url}\n${(r.content || "").slice(0, 800)}`)
      .join("\n\n");
    const messages = [
      { role: "system", content:
        `You are Megha, Megaska's shopping assistant. Use only the CONTEXT from megaska.com.
If unsure, say so and point to the site (collections, product page, size guide, returns). Be concise.` },
      { role: "system", content: `CONTEXT:\n${contextText || "(no relevant context found)"}` },
      { role: "user", content: userMessage },
    ];

    // 4) Stream
    const stream = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
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
    // 🔊 Make errors visible in the stream AND Vercel logs
    console.error("MEGHA_CHAT_ERROR", { message: e?.message, stack: e?.stack });
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message || "Internal error" })}\n\n`);
      res.end();
    } catch {
      res.status(500).json({ error: e?.message || "Internal error" });
    }
  }
}
