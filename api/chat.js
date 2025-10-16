// api/chat.js
// TEMP: log to Vercel server logs on each POST
console.log('[MEGHA][env]', {
  hasUrl: !!process.env.SUPABASE_URL,
  hasService: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
  hasAnon: !!process.env.SUPABASE_ANON_KEY
});

// EDGE-SAFE: no supabase-js import; uses PostgREST/RPC via fetch
export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;
function sbHeaders(json = true) {
  const h = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Accept-Profile': 'public',     // <— important
    'Content-Profile': 'public'     // <— important
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// RPC: match_web_chunks
async function sbMatchChunks(queryEmbedding, count = 8, thresh = 0.68) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_web_chunks`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({
      query_embedding: queryEmbedding,      // names must match function args
      match_count: count,
      similarity_threshold: thresh
    })
  });

  if (!r.ok) {
    const txt = await r.text().catch(()=>'');
    throw new Error(`rpc match_web_chunks ${r.status} ${txt.slice(0,200)}`);
  }
  return r.json();
}

// ---- CORS helpers ----
function cors(req) {
  const origin = req.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Vary': 'Origin'
  };
}
export async function OPTIONS(req) { return new Response(null, { status: 204, headers: cors(req) }); }
export async function GET() {

  export async function GET() {
  return new Response(JSON.stringify({
    ok: true,
    route: '/api/chat',
    version: 'health-rag-v2',
    hasUrl: !!process.env.SUPABASE_URL,
    hasService: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    hasAnon: !!process.env.SUPABASE_ANON_KEY,
    ts: Date.now()
  }), { status: 200, headers: { 'Content-Type': 'application/json' }});
}

  return new Response(JSON.stringify({ ok: true, route: '/api/chat', version: 'health-rag-v2', ts: Date.now() }), {
    status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// ---- OpenAI embedding ----
async function embed(text) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text })
  });
  if (!r.ok) throw new Error(`embed ${r.status}`);
  const j = await r.json();
  return j.data[0].embedding; // 1536-dim
}

// ---- Supabase REST helpers (Edge-compatible) ----
function sbHeaders(json = true) {
  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// RPC: match_web_chunks
async function sbMatchChunks(queryEmbedding, count = 8, thresh = 0.68) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_web_chunks`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      match_count: count,
      similarity_threshold: thresh
    })
  });
  if (!r.ok) throw new Error(`rpc match_web_chunks ${r.status}`);
  return r.json(); // array
}

// Insert conversation -> return id
async function sbCreateConversation(user_id = null, title = null) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/conversations`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify([{ user_id, title }])
  });
  if (!r.ok) throw new Error(`insert conversations ${r.status}`);
  const rows = await r.json();
  return rows?.[0]?.id || null;
}

// Insert messages (batch)
async function sbInsertMessages(rows) {
  if (!rows?.length) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify(rows)
  });
  if (!r.ok) throw new Error(`insert messages ${r.status}`);
}

export async function POST(req) {
  const headers = { 'Content-Type': 'application/json', ...cors(req) };
  try {
    const { message, session } = await req.json();
    if (!message || typeof message !== 'string') {
      return new Response(JSON.stringify({ ok:false, error:"Missing 'message' string" }), { status: 400, headers });
    }

    // 1) Embed query
    const qemb = await embed(message);

    // 2) Retrieve chunks via RPC
    const matches = await sbMatchChunks(qemb, 8, 0.68);

    // Dedupe best by URL
    const seen = new Set();
    const top = [];
    for (const m of matches || []) {
      if (!seen.has(m.url)) { seen.add(m.url); top.push(m); }
      if (top.length >= 5) break;
    }

    const context = top
      .map(m => `URL: ${m.url}\nCONTENT:\n${m.content}`)
      .join('\n\n---\n\n')
      .slice(0, 12000);

    // 3) Ask OpenAI with context
    const sys = `You are MEGHA, Megaska's AI sales assistant. Use ONLY the CONTEXT for factual answers (policies, sizing, materials, shipping). Be concise, friendly, and add a subtle call-to-action when relevant. If it isn't in context, say you're not sure and ask a clarifying question.`;
    const user = `Customer question: ${message}

CONTEXT:
${context}`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.2
      })
    });
    if (!r.ok) throw new Error(`openai ${r.status}`);
    const j = await r.json();
    const reply = j.choices?.[0]?.message?.content?.trim()
      || "I couldn’t find that in our site info yet. Could you share a bit more detail?";

    // 4) Save turn (best-effort; ignore errors)
    try {
      const convId = await sbCreateConversation(session?.customerId || null, null);
      if (convId) {
        await sbInsertMessages([
          { conversation_id: convId, role: 'user',      content: message, meta: null },
          { conversation_id: convId, role: 'assistant', content: reply,   meta: null }
        ]);
      }
    } catch (e) {
      console.log('[MEGHA][save] warn:', e?.message || e);
    }

    const sources = top.slice(0,3).map(s => ({ url: s.url, similarity: s.similarity }));
    return new Response(JSON.stringify({ ok: true, reply, sources }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({ ok:false, error: e?.message || String(e) }), { status: 500, headers });
  }
}
