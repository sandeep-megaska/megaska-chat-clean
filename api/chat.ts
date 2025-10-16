// api/chat.ts  — CORS-first, SSE stub so we can test end-to-end
export const config = { api: { bodyParser: false } };

function pickOrigin(req: any) {
  const allow = new Set((process.env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean));
  const o = req.headers?.origin as string | undefined;
  return (o && allow.has(o)) ? o : "*";
}
function setCORS(res: any, origin: string) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "content-type, authorization, x-requested-with, accept, origin");
}
async function readJSON(req: any) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { return {}; }
}

export default async function handler(req: any, res: any) {
  const origin = pickOrigin(req);
  setCORS(res, origin);

  // ✅ Preflight must succeed with CORS headers
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method Not Allowed" });

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const body = await readJSON(req);
  const msg  = (body?.message ?? "").toString();

  // Minimal stream in the shape your widget expects
  res.write(`data: ${JSON.stringify({ output_text: "Hi! Megha is online." })}\n\n`);
  res.write(`data: ${JSON.stringify({ output_text: " You said: " + msg })}\n\n`);
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
}
