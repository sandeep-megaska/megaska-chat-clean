// /api/chat.js — Edge-safe, hybrid retrieval, guaranteed sources, crisp answers
export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

// ---------- utils ----------
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

async function embed(text) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}`);
  const j = await r.json();
  return j.data[0].embedding; // 1536-dim
}

// ---------- Supabase helpers ----------
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
    const t = await r.text().catch(()=>'');
    throw new Error(`rpc match_web_chunks ${r.status} ${t.slice(0,200)}`);
  }
  return r.json();
}

// lightweight keyword fallback (BM25-like via ilike)
async function sbSearchPagesByKeyword(q, limit=8) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/web_pages`);
  url.searchParams.set('select', 'url,title');
  // OR across url/title (case-insensitive)
  url.searchParams.set('or', `(url.ilike.*${encodeURIComponent(q)}*,title.ilike.*${encodeURIComponent(q)}*)`);
  url.searchParams.set('limit', String(limit));
  const r = await fetch(url.toString(), { headers: sbHeaders(false) });
  if (!r.ok) return [];
  return r.json();
}
async function sbSearchChunksByKeyword(q, limit=12) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/web_chunks`);
  url.searchParams.set('select', 'url,content');
  url.searchParams.set('content', `ilike.*${encodeURIComponent(q)}*`);
  url.searchParams.set('limit', String(limit));
  const r = await fetch(url.toString(), { headers: sbHeaders(false) });
  if (!r.ok) return [];
  return r.json();
}

// ---------- rerank/merge ----------
function boostScore(item, base = 0) {
  // URL pattern boosts for helpful pages
  const u = (item.url || '').toLowerCase();
  let bonus = 0;
  if (u.includes('/size') || u.includes('size-chart') || u.includes('sizing')) bonus += 0.12;
  if (u.includes('/policies/') || u.includes('/policy')) bonus += 0.10;
  if (u.includes('/pages/') || u.includes('/faq')) bonus += 0.06;
  return (base || 0) + bonus;
}

function mergeAndRank(matches, kwPages, kwChunks, maxOut = 8) {
  const byUrl = new Map();

  // embeddings
  for (const m of matches || []) {
    const s = boostScore(m, Number(m.similarity) || 0);
    const prev = byUrl.get(m.url);
    if (!prev || s > prev.score) byUrl.set(m.url, { url: m.url, content: m.content, score: s, source: 'emb' });
  }

  // keyword pages
  for (const p of kwPages || []) {
    const s = boostScore(p, 0.55); // reasonable base
    const prev = byUrl.get(p.url);
    if (!prev || s > prev.score) byUrl.set(p.url, { url: p.url, content: '', score: s, source: 'kw-page' });
  }

  // keyword chunks
  for (const c of kwChunks || []) {
    const s = boostScore(c, 0.58);
    const prev = byUrl.get(c.url);
    if (!prev || s > prev.score) byUrl.set(c.url, { url: c.url, content: c.content || '', score: s, source: 'kw-chunk' });
  }

  return [...byUrl.values()]
    .sort((a,b) => b.score - a.score)
    .slice(0, maxOut);
}

// ---------- handler ----------
export default async function handler(req) {
  const h = corsHeaders(req);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

  if (req.method === 'GET') {
    return json({ ok: true, route: '/api/chat', version: 'health-rag-smart-v1', ts: Date.now() }, 200, h);
  }

  if (req.method !== 'POST') return json({ ok:false, error:'Method not allowed' }, 405, h);

  try {
    const body = await req.json().catch(()=> ({}));
    const message = body?.message;
    if (!message || typeof message !== 'string') {
      return json({ ok:false, error:"Missing 'message' string" }, 400, h);
    }

    // --- embed + retrieval (hybrid) ---
    let qemb = null;
    try { qemb = await embed(message); } catch (e) { /* still try keyword */ }

    let matches = [];
    try {
      if (qemb) {
        matches = await sbMatchChunks(qemb, 10, 0.68);
        if (!matches || matches.length < 2) matches = await sbMatchChunks(qemb, 12, 0.62);
        if (!matches || matches.length === 0) matches = await sbMatchChunks(qemb, 15, 0.58);
      }
    } catch (e) { /* fall back to keywords below */ }

    const wantsSize = /size|sizing|size\s*chart|measure/i.test(message);
    const wantsPolicy = /return|refund|exchange|policy|shipping|delivery/i.test(message);

    // keyword fallbacks target likely areas
    const kwTerms = wantsSize ? 'size' : wantsPolicy ? 'policy' : 'faq';
    const [kwPages, kwChunks] = await Promise.all([
      sbSearchPagesByKeyword(kwTerms, 8),
      sbSearchChunksByKeyword(kwTerms, 12),
    ]);

    const top = mergeAndRank(matches, kwPages, kwChunks, 6);

    // Build CONTEXT (concise)
    const context = top
      .map((m, i) => `SOURCE[${i+1}]: ${m.url}\n${(m.content || '').slice(0, 1400)}`)
      .join('\n\n---\n\n')
      .slice(0, 10000);

    // If still nothing, answer gracefully
    if (!context) {
      return json({
        ok: true,
        reply: "I couldn’t find that in our site content yet. Tell me the product or category, and I’ll guide you.",
        sources: []
      }, 200, h);
    }

    // --- ask OpenAI with strict output guidelines ---
    const sys = `You are MEGHA, Megaska's AI sales assistant.
Use ONLY the CONTEXT to answer about sizes/size charts, materials, shipping, returns, exchanges, and product details.
Be concise, specific, and conversion-oriented. Prefer bullet points. If sizing, explain how to measure & reference the size chart.
Always include a short CTA.
You MUST include a "Sources" section with clickable links to the top 2–3 SOURCE URLs provided. Do not invent links.`;

    const user = `Customer question: ${message}

CONTEXT:
${context}

RESPONSE FORMAT (strict):
- Start with a brief, specific answer (1–2 lines).
- If helpful, add 2–5 bullet points with the exact details pulled from CONTEXT.
- End with a short CTA (e.g., "Want help picking size? Tell me your height/weight and fit preference.").
- Then add:
Sources:
1. <clickable link to SOURCE[1] url>
2. <clickable link to SOURCE[2] url>
(Use the actual URLs from the SOURCE lines above. If fewer than 2 sources exist, show 1.)`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.15,
      }),
    });
    if (!r.ok) throw new Error(`openai ${r.status}`);
    const j = await r.json();
    let reply = j.choices?.[0]?.message?.content?.trim() || "I couldn’t find that in our site info yet.";

    // Build sources array for the widget
    const sources = top.slice(0, 3).map(s => ({ url: s.url, similarity: Number(s.score || 0).toFixed(3) }));

    return json({ ok: true, reply, sources }, 200, h);

  } catch (e) {
    return json({ ok:false, error: e?.message || String(e) }, 500, h);
  }
}
