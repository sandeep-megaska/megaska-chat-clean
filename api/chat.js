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
export const config = { runtime: 'edge' };

// ---- GLOBAL REQ TRACE (works for GET/POST/OPTIONS) ----
export async function GET(req) {
  console.log("[MEGHA][TRACE] GET /api/chat");
  return new Response(JSON.stringify({ ok: true, route: "/api/chat", ts: Date.now() }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }
  });
}

export async function OPTIONS(req) {
  console.log("[MEGHA][TRACE] OPTIONS /api/chat (preflight)");
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
      "Vary": "Origin"
    }
  });
}

// ---- POST HANDLER WITH FORCED EXTERNAL CALLS ----
import { createClient } from "@supabase/supabase-js";

export async function POST(req) {
  const started = Date.now();
  let bodyText = "";
  try { bodyText = await req.text(); } catch {}
  console.log("[MEGHA][TRACE] POST /api/chat", {
    len: bodyText?.length || 0,
    snippet: bodyText?.slice(0, 120)
  });

  // Re-parse JSON safely
  let payload = {};
  try { payload = bodyText ? JSON.parse(bodyText) : {}; } catch (e) {
    console.log("[MEGHA][TRACE] bad JSON:", e?.message);
  }
  const message = payload?.message;

  // 0) Guard prints (no early return yet)
  if (!message || typeof message !== "string") {
    console.log("[MEGHA][TRACE] missing/invalid 'message'");
  }

  // 1) FORCE a raw fetch to Supabase REST (to ensure 'External APIs' shows activity)
  try {
    const restUrl = `${process.env.SUPABASE_URL}/rest/v1/conversations?select=id&limit=1`;
    const r1 = await fetch(restUrl, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY }
    });
    console.log("[MEGHA][NET] raw supabase REST status:", r1.status);
  } catch (e) {
    console.log("[MEGHA][NET] raw supabase REST error:", e?.message || e);
  }

  // 2) Supabase client probe (count only)
  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    );
    const t0 = Date.now();
    const { count, error } = await supabase
      .from("conversations")
      .select("id", { head: true, count: "exact" });
    console.log("[MEGHA][DB] conversations count:", { count, error, ms: Date.now() - t0 });
  } catch (e) {
    console.log("[MEGHA][DB] fatal:", e?.message || e);
  }

  // 3) OpenAI ping (to confirm connectivity/keys)
  try {
    const r2 = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    console.log("[MEGHA][OAI] models status:", r2.status);
  } catch (e) {
    console.log("[MEGHA][OAI] network error:", e?.message || e);
  }

  // 4) Return a deterministic reply (so UI never spins)
  const reply = message
    ? `Megha here 👋 I received: "${message}".`
    : "Megha here 👋 I need a 'message' string in the body.";

  console.log("[MEGHA][TRACE] done in ms:", Date.now() - started);
  return new Response(JSON.stringify({ ok: true, reply }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Vary": "Origin"
    }
  });
}

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
