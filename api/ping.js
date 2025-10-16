// api/ping.js — trivial GET + OPTIONS, permissive CORS
export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).json({ error: "Method Not Allowed" });

  res.status(200).json({ ok: true, route: "/api/ping", ts: Date.now() });
}
