// /api/chat.js
// One default export handler to avoid "Unexpected export" build errors in bundlers.
// Edge-safe (no supabase-js). Uses PostgREST + OpenAI.

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

// ---------- helpers ----------
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });

const corsHeaders = (req) => {
  const origin = req.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Vary': 'Origin',
  };
};

async function embed(text) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}`);
  const j = await r.json();
  return j.data[0].embedding; // 1536
}

function sbHeaders(jsonType = true) {
  const h = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Accept-Profile': 'public',
    'Content-Profile': 'public',
  };
  if (jsonType) h['Content-Type'] = 'application/json';
  return h;
}

async function sbMatchChunks(queryEmbedding, count = 8, thresh = 0.68) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_web_chunks`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      match_count: count,
      similarity_threshold: thresh,
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`rpc match_web_chunks ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function sbCreateConversation(user_id = null, title = null) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/conversations`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify([{ user_id, title }]),
  });
  if (!r.ok) throw new Error(`insert conversations ${r.status}`);
  const rows = await r.json();
  return rows?.[0]?.id || null;
}

async function sbInsertMessages(rows) {
  if (!rows?.length) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`insert messages ${r.status}`);
}

// ---------- default export handler ----------
export default async function handler(req) {
  const h = corsHeaders(req);

  // OPTIONS (CORS preflight)
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: h });
  }

  // GET health
  if (req.method === 'GET') {
    return json(
      {
        ok: true,
        route: '/api/chat',
        version: 'health-rag-v3',
        ts: Date.now(),
      },
      200,
      h
    );
  }

  // POST chat
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'Method not allowed' }, 405, h);
  }

  try {
    let body = {};
    try { body = await req.json(); } catch {}
    const message = body?.message;
    const session = body?.session;

    if (!message || typeof message !== 'string') {
      return json({ ok: false, error: "Missing 'message' string" }, 400, h);
    }

    // 1) Embed
    const qemb = await embed(message);

    // 2) Retrieve (adaptive thresholds)
    let matches = await sbMatchChunks(qemb, 10, 0.68);
    if (!matches || matches.length < 2) matches = await sbMatchChunks(qemb, 12, 0.62);
    if (!matches || matches.length === 0) matches = await sbMatchChunks(qemb, 15, 0.58);

    // dedupe by URL
    const seen = new Set();
    const top = [];
    for (const m of matches || []) {
      if (!seen.has(m.url)) {
        seen.add(m.url);
        top.push(m);
      }
      if (top.length >= 6) break;
    }

    const context = top
      .map((m) => `URL: ${m.url}\nCONTENT:\n${m.content}`)
      .join('\n\n---\n\n')
      .slice(0, 10000);

    // 3) Ask OpenAI with context
    const sys =
      "You are MEGHA, Megaska's AI sales assistant. Use ONLY the CONTEXT for factual answers (policies, sizing/size charts, materials, shipping). Be concise, friendly, and add a subtle call-to-action where relevant. If it isn't in CONTEXT, say you're not sure and ask a helpful follow-up.";
    const user = `Customer question: ${message}\n\nCONTEXT:\n${context}`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
        temperature: 0.2,
      }),
    });
    if (!r.ok) throw new Error(`openai ${r.status}`);
    const j = await r.json();
    const reply =
      j.choices?.[0]?.message?.content?.trim() ||
      "I couldn’t find that in our site info yet. Could you share a bit more detail?";

    // 4) Save turn (best-effort)
    try {
      const convId = await sbCreateConversation(session?.customerId || null, null);
      if (convId) {
        await sbInsertMessages([
          { conversation_id: convId, role: 'user', content: message, meta: null },
          { conversation_id: convId, role: 'assistant', content: reply, meta: null },
        ]);
      }
    } catch (e) {
      // log only on server
      console.log('[MEGHA][save] warn:', e?.message || e);
    }

    const sources = top.slice(0, 4).map((s) => ({ url: s.url, similarity: s.similarity }));
    return json({ ok: true, reply, sources }, 200, h);
  } catch (e) {
    return json({ ok: false, error: e?.message || String(e) }, 500, h);
  }
}
