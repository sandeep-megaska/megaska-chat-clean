import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.setHeader("Access-Control-Allow-Origin","*"); return res.status(204).end(); }
  if (req.method !== "POST") return res.status(405).json({error:"Method Not Allowed"});

  // Read body safely in Vercel
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

  const { session_id, event, path, product_handle, meta } = body;
  const { error } = await supabase.from("events").insert({
    session_id, event, path, product_handle, meta, user_agent: req.headers["user-agent"]
  });
  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json({ ok: true });
}
