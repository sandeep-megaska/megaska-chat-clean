// api/chat.js — crash-proof health + echo (v: health-json-v3)
export default function handler(req, res) {
  // --- CORS (always) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, authorization, x-requested-with, accept, origin"
  );
  res.setHeader("Access-Control-Max-Age", "600");

  // --- Preflight ---
  if (req.method === "OPTIONS") {
    res.setHeader("Content-Length", "0");
    return res.status(200).end();
  }

  // --- Health check in a tab ---
  if (req.method === "GET") {
    return res
      .status(200)
      .json({ ok: true, route: "/api/chat", version: "health-json-v3", ts: Date.now() });
  }

  // --- Simple POST (no streaming yet) ---
  // replace your current POST handler with this:
if (req.method === "POST") {
  // SSE headers first so even errors are visible
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
console.log("MEGHA_CHAT: Incoming message stream started at", new Date());

  // Read body
  let bodyText = "";
  req.on("data", (chunk) => (bodyText += chunk));
  req.on("end", async () => {
    let body;
    try { body = JSON.parse(bodyText || "{}"); } catch { body = {}; }
    const userMessage =
      (typeof body?.message === "string" && body.message) ||
      (Array.isArray(body?.messages) && body.messages.at(-1)?.content) || "";

    if (!userMessage) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Missing 'message' in body" })}\n\n`);
      return res.end();
    }

    // Optional: stub switch while debugging (set MEGHA_MODE=stub in Vercel env)
    if ((process.env.MEGHA_MODE || "").toLowerCase() === "stub") {
      res.write(`data: ${JSON.stringify({ output_text: "Hi! Megha is online. " })}\n\n`);
      res.write(`data: ${JSON.stringify({ output_text: "Ready to help." })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      return res.end();
    }

    try {
      // Lazy imports to avoid top-level crashes
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
      const MAX_DISTANCE = Number(process.env.MAX_DISTANCE || 0.40);

      const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

      // 1) Embed
      const emb = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: userMessage,
      });
      const qVec = emb.data[0].embedding;

      // 2) Retrieve
      const { data: rows, error: rpcError } = await supabase.rpc("match_web_chunks", {
        query_embedding: qVec,
        match_count: MAX_CONTEXT_CHUNKS,
        max_distance: MAX_DISTANCE,
      });
      if (rpcError) throw new Error(`Supabase RPC error: ${rpcError.message}`);

      // 3) Prompt
      const contextText = (rows || [])
        .map((r, i) => `[#${i + 1}] ${r.url}\n${(r.content || "").slice(0, 800)}`)
        .join("\n\n");
      const messages = [
        { role: "system", content:
`You are Megha, Megaska's friendly shopping assistant.
Use ONLY the CONTEXT (from megaska.com). If unsure, say you aren't fully sure based on the site and suggest where to look (collections, product page, size guide, returns). Be concise.` },
        { role: "system", content: `CONTEXT:\n${contextText || "(no relevant context found)"}` },
        { role: "user", content: userMessage },
      ];

      // 4) Stream response
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

      // 5) Emit sources + close
      res.write(`event: sources\ndata: ${JSON.stringify((rows || []).map(r => ({ url: r.url, chunk_index: r.chunk_index })))}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (e) {
      console.error("MEGHA_CHAT_ERROR", { message: e?.message, stack: e?.stack });
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ error: e?.message || "Internal error" })}\n\n`);
        res.end();
      } catch {
        res.status(500).json({ error: e?.message || "Internal error" });
      }
    }
  });
  req.on("error", (e) => {
    console.error("READ_BODY_ERROR", e);
    res.write(`event: error\ndata: ${JSON.stringify({ error: "Bad body" })}\n\n`);
    res.end();
  });
  return;
}


  return res.status(405).json({ error: "Method Not Allowed" });
}
