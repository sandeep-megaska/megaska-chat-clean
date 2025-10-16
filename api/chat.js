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
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  let bodyText = "";
  req.on("data", (chunk) => (bodyText += chunk));
  req.on("end", () => {
    let body;
    try { body = JSON.parse(bodyText || "{}"); } catch { body = {}; }
    const message = (body?.message || "").toString();

    res.write(`data: ${JSON.stringify({ output_text: "Hi! Megha is online. " })}\n\n`);
    res.write(`data: ${JSON.stringify({ output_text: "You said: " + message })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, version: "sse-v1" })}\n\n`);
    res.end();
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
