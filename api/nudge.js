import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({error:"Method Not Allowed"});
  const { session_id } = await req.json?.() || await (async()=>JSON.parse(await new Response(req).text()))();
  const since = new Date(Date.now() - 1000*60*30).toISOString();
  const { data: events } = await supabase
    .from("events")
    .select("*")
    .eq("session_id", session_id)
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  let nudge = null;
  const viewed = events?.filter(e => e.event === "view_product") || [];
  const atc    = events?.some(e => e.event === "add_to_cart");
  const idle   = !atc && viewed.length && (Date.now() - new Date(viewed[0].created_at).getTime() > 20000);

  // Example rules
  if (viewed.filter(v => /burkini/i.test(v.product_handle || "")).length >= 2) {
    nudge = { type: "prompt", text: "Need help choosing your burkini size? I can help 🙂" };
  } else if (idle) {
    nudge = { type: "offer", text: "Psst—free swim cap with any swimwear today. Want details?" };
  }

  res.status(200).json({ nudge });
}
