// api/chat.js
export const config = { runtime: 'edge' };

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

function cors(req) {
  const origin = req.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Vary': 'Origin'
  };
}

export async function OPTIONS(req) {
  return new Response(null, { status: 204, headers: cors(req) });
}

export async function GET() {
  return new Response(JSON.stringify({ ok: true, route: '/api/chat', version: 'health-rag-v1', ts: Date.now() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

async function embed(text) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text })
  });
  if (!r.ok) throw new Error(`embed ${r.status}`);
  const j = await r.json();
  return j.data[0].embedding; // length 1536
}

export async function POST(req) {
  const headers = { 'Content-Type': 'application/json', ...cors(req) };
  try {
    const { message, session } = await req.json();
    if (!message || typeof message !== 'string') {
      return new Response(JSON.stringify({ ok: false, error: "Missing 'message' string" }), { status: 400, headers });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // 1) Embed the user query (must be 1536 dims)
    const qemb = await embed(message);

    // 2) Retrieve relevant chunks (tune threshold as needed)
    const { data: matches, error: rpcErr } = await supabase.rpc('match_web_chunks', {
      query_embedding: qemb,
      match_count: 8,
      similarity_threshold: 0.68
    });
    if (rpcErr) throw rpcErr;

    // Dedupe by URL and keep the best few
    const seen = new Set();
    const top = [];
    for (const m of matches || []) {
      if (!seen.has(m.url)) {
        seen.add(m.url);
        top.push(m);
      }
      if (top.length >= 5) break;
    }

    const context = top
      .map(m => `URL: ${m.url}\nCONTENT:\n${m.content}`)
      .join('\n\n---\n\n')
      .slice(0, 12000);

    // 3) Ask OpenAI with context (conversion-friendly)
    const sys = `You are MEGHA, Megaska's AI sales assistant. Use ONLY the CONTEXT for factual answers (policies, sizing, materials, shipping). Be concise, friendly, and add a subtle call-to-action if relevant. If the answer isn't in context, say you're not sure and ask a clarifying question.`;
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
    const j = await r.json();
    const reply = j.choices?.[0]?.message?.content || "Sorry, I couldn't find that in our site info yet.";

    // (Optional) Save turn
    try {
      const { data: conv } = await supabase.from('conversations').insert({
        user_id: session?.customerId || null, title: null
      }).select('id').single();
      if (conv?.id) {
        await supabase.from('messages').insert([
          { conversation_id: conv.id, role: 'user',      content: message },
          { conversation_id: conv.id, role: 'assistant', content: reply }
        ]);
      }
    } catch (e) {
      console.log('[MEGHA][save] warn:', e?.message || e);
    }

    // Return a few sources for transparency
    const sources = top.slice(0, 3).map(s => ({ url: s.url, similarity: s.similarity }));
    return new Response(JSON.stringify({ ok: true, reply, sources }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e?.message || String(e) }), { status: 500, headers });
  }
}
