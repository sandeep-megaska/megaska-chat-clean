// /api/ingest.js
// Edge-safe sitemap crawler + chunker + embedder + upserter (no supabase-js)
export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

// ---- config you can tweak ----
const DEFAULT_SITEMAPS = [
  'https://megaska.com/sitemap.xml',
  'https://megaska.com/sitemap_pages_1.xml',
  'https://megaska.com/sitemap_products_1.xml',
];
const DEFAULT_LIMIT   = 120;   // cap pages in one run
const CHUNK_SIZE      = 900;   // ~chars
const CHUNK_OVERLAP   = 150;   // ~chars
const BATCH_EMB       = 64;    // embeddings per batch
const MODEL_EMB       = 'text-embedding-3-small'; // 1536-dim

// ---- helpers ----
const J = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const sbHeaders = (json = true) => {
  const h = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Accept-Profile': 'public',
    'Content-Profile': 'public',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
};

const tidyHtmlToText = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function chunk(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + size);
    const slice = text.slice(i, end).trim();
    if (slice) out.push(slice);
    i = end - overlap;
    if (i <= 0) i = end;
  }
  return out;
}

async function embedBatch(texts) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL_EMB, input: texts }),
  });
  if (!r.ok) throw new Error(`openai embeddings ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.data.map(d => d.embedding);
}

async function parseSitemapOrIndex(url, seen = new Set(), depth = 0) {
  // Prevent loops
  if (seen.has(url) || depth > 4) return [];
  seen.add(url);

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`sitemap fetch ${res.status} ${url}`);
  const xml = await res.text();

  // Normalize whitespace
  const body = xml.replace(/\s+/g, ' ');

  // Is it a <sitemapindex>?
  const isIndex = /<\s*sitemapindex\b/i.test(body);
  // Capture <loc> and also namespaced <ns:loc>
  const LOC_RE = /<\s*(?:[a-zA-Z0-9]+:)?loc\s*>\s*([^<]+?)\s*<\s*\/\s*(?:[a-zA-Z0-9]+:)?loc\s*>/gi;

  const locs = [];
  let m;
  while ((m = LOC_RE.exec(body))) {
    const loc = m[1].trim();
    if (loc) locs.push(loc);
  }

  if (isIndex) {
    // Recurse into each child sitemap
    let urls = [];
    for (const sm of locs) {
      try {
        const child = await parseSitemapOrIndex(sm, seen, depth + 1);
        urls.push(...child);
      } catch (e) {
        console.log('[INGEST][sitemapindex] skip', sm, e.message || e);
      }
    }
    return urls;
  }

  // It's a urlset → locs are page URLs
  return locs;
}

async function upsertPage(url, title) {
  // upsert by url (on_conflict=url) and return the row (need the id)
  const endpoint = new URL(`${SUPABASE_URL}/rest/v1/web_pages`);
  endpoint.searchParams.set('on_conflict', 'url');
  const r = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ url, title, metadata: null, crawled_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw new Error(`upsert web_pages ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows?.[0]; // { id, url, ... }
}

async function insertChunks(rows) {
  if (!rows.length) return;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/web_chunks`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`insert web_chunks ${r.status} ${await r.text()}`);
}

async function fetchPage(url) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`page fetch ${r.status} ${url}`);
  const html = await r.text();
  const title = (html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || url).trim();
  const text = tidyHtmlToText(html);
  return { title, text };
}

// ---- handler ----
export default async function handler(req) {
  try {
    // Basic env sanity
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or key');
    if (!OPENAI_KEY) throw new Error('Missing OPENAI_API_KEY');

    const url = new URL(req.url);
    const limitParam   = Number(url.searchParams.get('limit')) || DEFAULT_LIMIT;
    const sitemapsParam = url.searchParams.getAll('sitemap').filter(Boolean);
    const sitemaps = sitemapsParam.length ? sitemapsParam : DEFAULT_SITEMAPS;

    // Collect URLs
    // Collect URLs (handles sitemap indexes and urlsets)
let urls = [];
const perSitemapStats = [];
for (const sm of sitemaps) {
  try {
    const list = await parseSitemapOrIndex(sm);
    perSitemapStats.push({ sitemap: sm, found: list.length });
    urls.push(...list);
  } catch (e) {
    console.log('[INGEST][sitemap] skip', sm, e.message || e);
    perSitemapStats.push({ sitemap: sm, error: e.message || String(e) });
  }
}
urls = Array.from(new Set(urls)).slice(0, limitParam);


    let pages = 0;
    let chunksTotal = 0;
    const started = Date.now();

    for (const u of urls) {
      try {
        const { title, text } = await fetchPage(u);
        if (!text || text.length < 300) { continue; }

        const page = await upsertPage(u, title);
        const pageId = page?.id;
        if (!pageId) throw new Error('no page id from upsert');

        const parts = chunk(text);
        // embed + insert in batches
        for (let i = 0; i < parts.length; i += BATCH_EMB) {
          const batchTexts = parts.slice(i, i + BATCH_EMB);
          const embs = await embedBatch(batchTexts);
          const rows = batchTexts.map((content, idx) => ({
            page_id: pageId,
            url: u,
            content,
            token_count: content.length,
            embedding: embs[idx],       // PostgREST accepts number arrays for vector
            metadata: null,
            created_at: new Date().toISOString()
          }));
          await insertChunks(rows);
          chunksTotal += rows.length;
        }
        pages += 1;
      } catch (e) {
        console.log('[INGEST][page] skip', u, e.message || e);
      }
    }

    return J({
  ok: true,
  pages,
  chunks: chunksTotal,
  ms: Date.now() - started,
  sitemaps,
  limit: limitParam,
  discovered_urls: urls.length,
  perSitemapStats
});


  } catch (e) {
    // Return the error so you can see it in the browser
    return J({ ok: false, error: e?.message || String(e) }, 500);
  }
}
