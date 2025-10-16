// /api/chat.js — Edge-safe, hybrid retrieval, no source list in replies
export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra } });

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
  return j.data[0].embedding;
}

async function sbMatchChunks(queryEmbedding, count = 10, thresh = 0.68) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_web_chunks`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({
      query_embedding: queryEmbedding,
      match_count: count,
      similarity_threshold: thresh,
    }),
  });
  if (!r.ok) throw new Error(`rpc match_web_chunks ${r.status} ${await r.text().catch(()=> '')}`);
  return r.json();
}

async function sbSearchPagesByKeyword(q, limit=8) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/web_pages`);
  url.searchParams.set('select', 'url,title');
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

function boostScore(item, base = 0) {
  const u = (item.url || '').toLowerCase();
  let bonus = 0;
  if (u.includes('/size') || u.includes('size-chart') || u.includes('sizing')) bonus += 0.14;
  if (u.includes('/policies/') || u.includes('/policy')) bonus += 0.10;
  if (u.includes('/pages/') || u.includes('/faq')) bonus += 0.06;
  return (base || 0) + bonus;
}

function mergeAndRank(matches, kwPages, kwChunks, maxOut = 6) {
  const byUrl = new Map();
  for (const m of matches || []) {
    const s = boostScore(m, Number(m.similarity) || 0);
    const prev = byUrl.get(m.url);
    if (!prev || s > prev.score) byUrl.set(m.url, { url: m.url, content: m.content, score: s, source: 'emb' });
  }
  for (const p of kwPages || []) {
    const s = boostScore(p, 0.55);
    const prev = byUrl.get(p.url);
    if (!prev || s > prev.score) byUrl.set(p.url, { url: p.url, content: '', score: s, source: 'kw-page' });
  }
  for (const c of kwChunks || []) {
    const s = boostScore(c, 0.58);
    const prev = byUrl.get(c.url);
    if (!prev || s > prev.score) byUrl.set(c.url, { url: c.url, content: c.content || '', score: s, source: 'kw-chunk' });
  }
  return [...byUrl.values()].sort((a,b)=> b.score - a.score).slice(0, maxOut);
}

export default async function handler(req) {
  const h = corsHeaders(req);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (req.method === 'GET')    return json({ ok:true, route:'/api/chat', version:'health-rag-nosrc-v1', ts: Date.now() }, 200, h);
  if (req.method !== 'POST')   return json({ ok:false, error:'Method not allowed' }, 405, h);

  try {
    const { message } = await req.json().catch(()=> ({}));
    if (!message || typeof message !== 'string') return json({ ok:false, error:"Missing 'message' string" }, 400, h);

    let qemb = null;
    try { qemb = await embed(message); } catch {}

    let matches = [];
    try {
      if (qemb) {
        matches = await sbMatchChunks(qemb, 10, 0.68);
        if (!matches || matches.length < 2) matches = await sbMatchChunks(qemb, 12, 0.62);
        if (!matches || matches.length === 0) matches = await sbMatchChunks(qemb, 15, 0.58);
      }
    } catch {}

    const wantsSize   = /size|sizing|size\s*chart|measure/i.test(message);
    const wantsPolicy = /return|refund|exchange|policy|shipping|delivery/i.test(message);
    const kwTerms = wantsSize ? 'size' : wantsPolicy ? 'policy' : 'faq';

    const [kwPages, kwChunks] = await Promise.all([
      sbSearchPagesByKeyword(kwTerms, 8),
      sbSearchChunksByKeyword(kwTerms, 12),
    ]);

    const top = mergeAndRank(matches, kwPages, kwChunks, 6);

    // Build compact context for the model (no “Sources” header)
    const context = top
      .map((m) => `URL: ${m.url}\n${(m.content || '').slice(0, 1400)}`)
      .join('\n\n---\n\n')
      .slice(0, 10000);

    // Optional CTA: if a product page is on top, pass it back
    const primaryLink = top.find(t => /\/products\//i.test(t.url))?.url || top[0]?.url || null;

    const sys = `You are MEGHA, Megaska's AI sales assistant. Answer ONLY from the CONTEXT (Megaska's own pages).
Be concise, specific, and conversion-oriented. Use bullets when helpful. If sizing, explain how to measure and what to check.
Do not mention sources or URLs explicitly in your answer. Keep the tone friendly and confident.`;

    const user = `Customer question: ${message}

CONTEXT:
${context}

Write a short, specific answer. Use 2–5 bullets if it helps clarity. End with a brief CTA (e.g., "Want help choosing size? Tell me your height/weight and fit preference.").`;

    let reply = "I couldn’t find that in our site info yet. Could you share a bit more detail?";
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
          temperature: 0.15,
        }),
      });
      if (r.ok) {
        const j = await r.json();
        reply = j.choices?.[0]?.message?.content?.trim() || reply;
      }
    } catch {}

    // return reply only (no sources), with optional CTA link for your UI
    return json({ ok: true, reply, cta: primaryLink ? { label: 'View details', href: primaryLink } : null }, 200, h);

  } catch (e) {
    return json({ ok:false, error: e?.message || String(e) }, 500, h);
  }
}
