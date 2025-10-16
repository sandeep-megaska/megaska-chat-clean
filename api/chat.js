// api/chat.js — SSE stub, no deps, no body parsing, wildcard CORS
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  // CORS first
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(204).end();

  // Make GET return JSON (so visiting /api/chat in a tab shows 200, not 500)
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, route: "/api/chat", ts: Date.now() });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });

  // Minimal SSE (no body read; no Buffer usage)
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  // Just stream two lines in the exact shape your widget expects
  res.write(`data: ${JSON.stringify({ output_text: "Hi! Megha is online." })}\n\n`);
  res.write(`data: ${JSON.stringify({ output_text: " Ready to help. " })}\n\n`);
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
}
