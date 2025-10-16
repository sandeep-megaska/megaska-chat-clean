export const config = { runtime: 'nodejs' };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

const CHUNK_SIZE = 900, CHUNK_OVERLAP = 150, EMB_MODEL = 'text-embedding-3-small';

const J = (obj, status=200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type':'application/json', 'Cache-Control':'no-store' } });
const sbH = (json=true) => {
  const h = { apikey: SUPABASE_KEY, Authorization:`Bearer ${SUPABASE_KEY}`, 'Accept-Profile':'public', 'Content-Profile':'public' };
  if (json) h['Content-Type']='application/json'; return h;
};
const tidy = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi,' ')
  .replace(/<style[\s\S]*?<\/style>/gi,' ')
  .replace(/<[^>]+>/g,' ')
  .replace(/\s+/g,' ').trim();

function chunk(t){ const out=[]; for(let i=0;i<t.length;){const end=Math.min(t.length,i+CHUNK_SIZE); const s=t.slice(i,end).trim(); if(s) out.push(s); if(end>=t.length) break; i=end-CHUNK_OVERLAP;} return out; }

async function embedBatch(texts){
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method:'POST',
    headers:{ Authorization:`Bearer ${OPENAI_KEY}`,'Content-Type':'application/json' },
    body: JSON.stringify({ model: EMB_MODEL, input: texts })
  });
  if(!r.ok) throw new Error(`openai emb ${r.status} ${await r.text()}`);
  const j = await r.json(); return j.data.map(d=>d.embedding);
}

async function upsertPage(url, title) {
  const u = new URL(`${SUPABASE_URL}/rest/v1/web_pages`);
  u.searchParams.set('on_conflict','url');
  const r = await fetch(u.toString(), {
    method:'POST',
    headers:{ ...sbH(), Prefer:'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ url, title, metadata:null, crawled_at:new Date().toISOString() }])
  });
  if(!r.ok) throw new Error(`upsert web_pages ${r.status} ${await r.text()}`);
  const rows = await r.json(); return rows?.[0];
}

async function insertChunks(rows){
  if(!rows.length) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/web_chunks`, {
    method:'POST', headers: sbH(), body: JSON.stringify(rows)
  });
  if(!r.ok) throw new Error(`insert web_chunks ${r.status} ${await r.text()}`);
}

export default async function handler(req){
  try{
    const urlObj = new URL(req.url);
    const target = urlObj.searchParams.get('url');
    if(!target) return J({ ok:false, error:"Pass ?url=https://..." }, 400);

    const res = await fetch(target, { redirect:'follow' });
    if(!res.ok) return J({ ok:false, error:`fetch ${res.status}` }, 500);
    const html = await res.text();
    const title = (html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || target).trim();
    const text  = tidy(html);
    if(!text || text.length < 200) return J({ ok:false, error:'page too short' }, 400);

    const page = await upsertPage(target, title);
    if(!page?.id) return J({ ok:false, error:'no page id' }, 500);

    const parts = chunk(text);
    const embs  = await embedBatch(parts);
    const rows  = parts.map((content, i) => ({
      page_id: page.id, url: target, content,
      token_count: content.length, embedding: embs[i],
      metadata:null, created_at:new Date().toISOString()
    }));
    await insertChunks(rows);

    return J({ ok:true, url: target, page_id: page.id, title, chunks: rows.length });
  }catch(e){
    return J({ ok:false, error:e?.message || String(e) }, 500);
  }
}
