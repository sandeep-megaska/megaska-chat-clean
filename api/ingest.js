// /api/ingest.js
// Node runtime (NOT Edge) so we have more time for crawling/embedding.
// SDK-free: talks to Supabase via PostgREST, OpenAI via HTTPS.

export const config = { runtime: 'nodejs' };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

// -------- tweakables ----------
const DEFAULT_SITEMAPS = [
  'https://megaska.com/sitemap.xml',
  'https://megaska.com/sitemap_pages_1.xml',
  'https://megaska.com/sitemap_products_1.xml',
];

const DEFAULT_LIMIT      = 60;    // total pages per run (keep modest first)
const MAX_CONCURRENT     = 4;     // parallel page fetches
const FETCH_TIMEOUT_MS   = 12000; // per fetch timeout
const EMB_BATCH_SIZE     = 48;    // embeddings per batch
const CHUNK_SIZE         = 900;   // chars
const CHUNK_OVERLAP      = 150;   // chars
const EMB_MODEL          = 'text-embedding-3-small'; // 1536-dim

// ---------- utils ----------
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

const sbHeaders = (jsonType = true) => {
  const h = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Accept-Profile': 'public',
    'Content-Profile': 'public',
  };
  if (jsonType) h['Content-Type'] = 'application/json';
  return h;
};
// Allowlist patterns for quick mode (edit to taste)
const QUICK_ALLOW = [
  '/pages/', '/policies/', '/policy', '/faq', '/faqs',
  '/size', 'size-chart', 'sizing', '/shipping', '/delivery', '/returns', '/exchange'
];

function quickFilterUrls(urls) {
  const low = QUICK_ALLOW.map(s => s.toLowerCase());
  return urls.filter(u => {
    const lu = u.toLowerCase();
    return low.some(s => lu.includes(s));
  });
}

function tidyHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const out = [];
  for (let i = 0; i < text.length; ) {
    const end = Math.min(text.length, i + size);
    const slice = text.slice(i, end).trim();
    if (slice) out.push(slice);
    if (end >= text.length) break;
    i = end - overlap;
  }
  return out;
}

async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// robust for sitemapindex + urlset (handles namespaces)
async function parseSitemapOrIndex(url, seen = new Set(), depth = 0) {
  if (seen.has(url) || depth > 4) return [];
  seen.add(url);

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`sitemap ${res.status} ${url}`);
  const xml = await res.text();
  const body = xml.replace(/\s+/g, ' ');
  const LOC_RE = /<\s*(?:[a-zA-Z0-9]+:)?loc\s*>\s*([^<]+?)\s*<\s*\/\s*(?:[a-zA-Z0-9]+:)?loc\s*>/gi;

  const isIndex = /<\s*sitemapindex\b/i.test(body);
  const locs = [];
  let m;
  while ((m = LOC_RE.exec(body))) locs.push(m[1].trim());

  if (isIndex) {
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
  return locs; // urlset
}

async function embedBatch(texts) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMB_MODEL, input: texts }),
  });
  if (!r.ok) throw new Error(`openai embeddings ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.data.map(d => d.embedding);
}

async function upsertPage(url, title) {
  const endpoint = new URL(`${SUPABASE_URL}/rest/v1/web_pages`);
  endpoint.searchParams.set('on_conflict', 'url');
  const r = await fetch(endpoint.toString(), {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ url, title, metadata: null, crawled_at: new Date().toISOString() }]),
  });
  if (!r.ok) throw new Error(`upsert web_pages ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows?.[0]; // includes id
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

async function fetchPageText(url) {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`page ${res.status} ${url}`);
  const ct = res.headers.get('content-type') || '';
  if (!/text\/html/i.test(ct)) throw new Error(`non-HTML content (${ct})`);
  const html = await res.text();
  const title = (html.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || url).trim();
  const text = tidyHtmlToText(html);
  return { title, text };
}

// simple concurrency pool
async function pmap(items, limit, worker) {
  const ret = [];
  let i = 0, inFlight = 0;
  return await new Promise((resolve) => {
    const next = () => {
      while (inFlight < limit && i < items.length) {
        const idx = i++, item = items[idx];
        inFlight++;
        Promise.resolve(worker(item, idx))
          .then((val) => { ret[idx] = val; })
          .catch((err) => { ret[idx] = { error: err?.message || String(err) }; })
          .finally(() => { inFlight--; if (i >= items.length && inFlight === 0) resolve(ret); else next(); });
      }
    };
    next();
  });
}

export default async function handler(req) {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL/KEY');
    if (!OPENAI_KEY) throw new Error('Missing OPENAI_API_KEY');

    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1000));
    const dry   = url.searchParams.get('dry') === '1'; // dry run: discover only
    const sitemapsQuery = url.searchParams.getAll('sitemap').filter(Boolean);
    const sitemaps = sitemapsQuery.length ? sitemapsQuery : DEFAULT_SITEMAPS;

    // 1) Collect URLs (handles sitemap indexes)
    let discovered = [];
    const perSitemapStats = [];
    for (const sm of sitemaps) {
      try {
        const list = await parseSitemapOrIndex(sm);
        perSitemapStats.push({ sitemap: sm, found: list.length });
        discovered.push(...list);
      } catch (e) {
        perSitemapStats.push({ sitemap: sm, error: e?.message || String(e) });
      }
    }
    discovered = Array.from(new Set(discovered)).slice(0, limit);

    if (dry) {
      return json({
        ok: true,
        mode: 'dry',
        discovered_urls: discovered.length,
        perSitemapStats
      });
    }
const quick = url.searchParams.get('quick') === '1';
if (quick) {
  discovered = quickFilterUrls(discovered);
}
discovered = Array.from(new Set(discovered)).slice(0, limit);

    // 2) Fetch pages concurrently (bounded)
    const pageResults = await pmap(discovered, MAX_CONCURRENT, async (u) => {
      try {
        const { title, text } = await fetchPageText(u);
        if (!text || text.length < 300) return { url: u, skipped: 'too-short' };
        return { url: u, title, text };
      } catch (e) {
        return { url: u, error: e?.message || String(e) };
      }
    });

    const toIngest = pageResults.filter(p => !p.error && !p.skipped).slice(0, limit);
    let pages = 0, chunks = 0;

    // 3) Upsert pages + chunk + embed in batches
    for (const p of toIngest) {
      try {
        const pageRow = await upsertPage(p.url, p.title);
        const pageId = pageRow?.id;
        if (!pageId) throw new Error('no page id');

        const parts = chunkText(p.text);
        for (let i = 0; i < parts.length; i += EMB_BATCH_SIZE) {
          const batch = parts.slice(i, i + EMB_BATCH_SIZE);
          const embs  = await embedBatch(batch);
          const rows  = batch.map((content, idx) => ({
            page_id: pageId,
            url: p.url,
            content,
            token_count: content.length,
            embedding: embs[idx],
            metadata: null,
            created_at: new Date().toISOString()
          }));
          await insertChunks(rows);
          chunks += rows.length;
        }
        fetch('https://megaska-chat-clean.vercel.app/api/chat', {
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ message: 'Do you have a size chart?' })
}).then(r=>r.json()).then(console.log)

        pages += 1;
      } catch (e) {
        console.log('[INGEST][page] failed', p.url, e?.message || e);
      }
    }

    return json({
      ok: true,
      pages,
      chunks,
      discovered_urls: discovered.length,
      fetched_ok: toIngest.length,
      perSitemapStats
    });

  } catch (e) {
    return json({ ok: false, error: e?.message || String(e) }, 500);
  }
}
