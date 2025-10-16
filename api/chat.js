// api/chat.js
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  // Use SERVICE ROLE on the server to bypass RLS
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

try {
  const t0 = Date.now();
  const { count, error } = await supabase
    .from("conversations")
    .select("id", { head: true, count: "exact" });
  console.log("[MEGHA][DB] conversations count:", { count, error, ms: Date.now() - t0 });
} catch (e) {
  console.log("[MEGHA][DB] fatal:", e?.message || e);
}

export const config = { runtime: 'edge' }; // keep Edge; works fine for now

function errJSON(origin, status, msg) {
  return new Response(JSON.stringify({ error: msg, status }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Vary": "Origin"
    }
  });
}

const ALLOWED_ORIGINS = new Set([
  "https://megaska.com",
  "https://www.megaska.com",
  "https://megaska.myshopify.com"
]);

function pickOrigin(req) {
  const o = req.headers.get("Origin");
  return (o && ALLOWED_ORIGINS.has(o)) ? o : "*";
}

export async function OPTIONS(req) {
  const origin = pickOrigin(req);
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Vary": "Origin"
    }
  });
}

export async function GET(req) {
  const origin = pickOrigin(req);
  const body = {
    ok: true,
    route: "/api/chat",
    version: "health-json-v3",
    ts: Date.now()
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin"
    }
  });
}

export async function POST(req) {
  const origin = pickOrigin(req);
  try {
    const { message } = await req.json();

    if (!message || typeof message !== "string") {
      return errJSON(origin, 400, "Missing 'message' string");
    }

    // TEMP: stub reply so the widget never hangs
    const reply = `Megha here 👋 I received: "${message}". (Stub reply while we stabilize)`;

    return new Response(JSON.stringify({ ok: true, reply }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin"
      }
    });
  } catch (e) {
    return errJSON(origin, 500, `Server error: ${e?.message || e}`);
  }
}
