import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({error:"Method Not Allowed"});

  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const { session_id } = body;

  const since = new Date(Date.now() - 30*60*1000).toISOString();
  const { data: events } = await supabase
    .from("events")
    .select("*")
    .eq("session_id", session_id)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  let nudge = null;
  const viewed = (events||[]).filter(e => e.event === "view_product");
  const sawBurkini = viewed.filter(v => /burkini/i.test(v.product_handle||"")).length >= 2;
  const lastView = viewed[0]?.created_at && new Date(viewed[0].created_at).getTime();
  const idle = lastView && (Date.now() - lastView > 20000);

  if (sawBurkini) {
    nudge = { type: "prompt", text: "Need help choosing your burkini size? I can help 🙂" };
  } else if (idle) {
    nudge = { type: "offer", text: "Psst—free swim cap with any swimwear today. Want details?" };
  }

  res.status(200).json({ nudge });
}
