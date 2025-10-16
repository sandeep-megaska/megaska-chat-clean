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
  if (req.method === "POST") {
    let bodyText = "";
    req.on("data", (chunk) => (bodyText += chunk));
    req.on("end", () => {
      let body;
      try { body = JSON.parse(bodyText || "{}"); } catch { body = {}; }
      const message = (body?.message || "").toString();
      return res
        .status(200)
        .json({ ok: true, echo: message, version: "health-json-v3" });
    });
    req.on("error", (e) => {
      console.error("READ_BODY_ERROR", e);
      return res.status(400).json({ ok: false, error: "Bad body" });
    });
    return;
  }

  return res.status(405).json({ error: "Method Not Allowed" });
}
