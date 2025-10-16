// api/ping.ts
export default async function handler(req: any, res: any) {
  const allowSet = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean));
  const origin = req.headers?.origin;
  const allow = (origin && allowSet.has(origin)) ? origin : "*";

  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  res.status(200).json({ ok: true, ts: Date.now() });
}
