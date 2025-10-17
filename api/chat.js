// /api/chat.js — MEGASKA Smart Fast Path (Edge, brand-grounded)
export const config = { runtime: 'edge' };

/* ----------------------- ENV ----------------------- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

/* ----------------------- UTILS ----------------------- */
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }
  });
async function shopifySearchProducts(query, limit = 4) {
  const endpoint = `https://${process.env.SHOPIFY_STORE_DOMAIN}/api/2024-10/graphql.json`;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'X-Shopify-Storefront-Access-Token': process.env.SHOPIFY_STOREFRONT_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query: `
        query($q:String!, $n:Int!) {
          products(first:$n, query:$q) {
            edges { node { handle title onlineStoreUrl } }
          }
          collections(first:$n, query:$q) {
            edges { node { handle title } }
          }
        }`,
      variables: { q: query, n: limit }
    })
  });
  if (!r.ok) return [];
  const j = await r.json();
  const products = (j.data?.products?.edges || []).map(({ node }) => ({
    title: node.title,
    url: node.onlineStoreUrl || `https://megaska.com/products/${node.handle}`
  }));
  const collections = (j.data?.collections?.edges || []).map(({ node }) => ({
    title: node.title,
    url: `https://megaska.com/collections/${node.handle}`
  }));
  return [...products, ...collections].slice(0, limit);
}

const cors = (req) => {
  const origin = req.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin === 'null' ? '*' : origin,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Vary': 'Origin'
  };
};

function sbHeaders(jsonType = true) {
  const h = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Accept-Profile': 'public',
    'Content-Profile': 'public'
  };
  if (jsonType) h['Content-Type'] = 'application/json';
  return h;
}

/* ----------------------- BRAND BRAIN ----------------------- */
const BRAND = {
  name: "MEGASKA",
  whatWeDo:
    "Modest & stylish swimwear for Indian women — from swim dresses and one-pieces to burkinis and rash guards. Mix-and-match swim tops & bottoms for flexibility.",
  tone:
    "friendly, confident, concise, owner-led; speak as MEGASKA (first party), never generic.",
  materials:
    "Premium polyester–spandex (polyester lycra) blends that are quick-dry, durable, and comfortable with reasonable stretch.",
  fit:
    "Designed with Indian women’s body types in mind for confident coverage and comfort.",
  delivery: {
    dispatch: "Most orders ship within 1 business day after confirmation.",
    timeframe: "Delivery across India is typically 3–5 working days depending on city/courier availability.",
    express: "We use one reliable method for all orders (no separate 'express'/'standard' tiers).",
    tracking: "Tracking is shared via email/WhatsApp as soon as the order is dispatched."
  },
  returns: {
    policy:
      "Easy exchanges within the policy window for unused items with tags intact; standard hygiene rules apply for swimwear.",
    how:
      "Start an exchange from your order confirmation link or message us with your order number."
  },
  ordering: {
    steps: [
      "Choose your style, select size/colour, add to cart.",
      "Checkout with shipping details and payment.",
      "Get instant order confirmation on email/WhatsApp.",
      "We pack within 1 business day and share tracking."
    ]
  },
  payments:
    "All common online payment options are supported at checkout (COD only if explicitly enabled on the store).",
  // Updated with your real WhatsApp:
  contact:
    "WhatsApp/Call us at **+91 9650957372** or message us on the site. Share your order number for fastest help (10:00–18:00 IST).",
  promo: {
    code: "MEGA15",
    desc: "Use code MEGA15 for 15% off on all orders."
  },
  clearance:
    "We’re running a clearance sale on shapewear and sleepwear collections—limited sizes while stocks last."
};

/* ----------------------- LIGHT SEARCH (keyword) ----------------------- */
async function kwPages(q, limit = 6) {
  const u = new URL(`${SUPABASE_URL}/rest/v1/web_pages`);
  u.searchParams.set('select', 'url,title');
  u.searchParams.set('or', `(url.ilike.*${encodeURIComponent(q)}*,title.ilike.*${encodeURIComponent(q)}*)`);
  u.searchParams.set('limit', String(limit));
  const r = await fetch(u.toString(), { headers: sbHeaders(false) });
  return r.ok ? r.json() : [];
}

async function kwChunks(q, limit = 10) {
  const u = new URL(`${SUPABASE_URL}/rest/v1/web_chunks`);
  u.searchParams.set('select', 'url,content');
  u.searchParams.set('content', `ilike.*${encodeURIComponent(q)}*`);
  u.searchParams.set('limit', String(limit));
  const r = await fetch(u.toString(), { headers: sbHeaders(false) });
  return r.ok ? r.json() : [];
}

/* ----------------------- EMBEDDINGS (fallback) ----------------------- */
async function embed(text) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text })
  });
  if (!r.ok) throw new Error(`embed ${r.status}`);
  const j = await r.json();
  return j.data[0].embedding;
}

async function matchChunks(queryEmbedding, count = 10, thresh = 0.66) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_web_chunks`, {
    method: 'POST',
    headers: sbHeaders(),
    body: JSON.stringify({ query_embedding: queryEmbedding, match_count: count, similarity_threshold: thresh })
  });
  if (!r.ok) return [];
  return r.json();
}

/* ----------------------- PRODUCT/COLLECTION LINKING ----------------------- */
async function findProductsAndCollections(q, limit = 4) {
  const base = `${SUPABASE_URL}/rest/v1/web_pages`;
  const sel  = 'url,title';
  const like = encodeURIComponent(`*${q}*`);
  const u = new URL(base);
  u.searchParams.set('select', sel);
  u.searchParams.set('or', `(title.ilike.${like},url.ilike.${like})`);
  u.searchParams.set('limit', String(Math.max(1, Math.min(limit, 8))));
  const r = await fetch(u.toString(), { headers: sbHeaders(false) });
  if (!r.ok) return [];
  const rows = (await r.json()) || [];
  return rows
    .filter(x => /\/(products|collections)\//i.test(x.url))
    .slice(0, limit);
}

async function extLinks(q, limit = 4) {
  const u = new URL(`${SUPABASE_URL}/rest/v1/external_links`);
  u.searchParams.set('select', 'store,label,url,notes');
  u.searchParams.set('or', `(label.ilike.*${encodeURIComponent(q)}*,notes.ilike.*${encodeURIComponent(q)}*)`);
  u.searchParams.set('limit', String(limit));
  const r = await fetch(u.toString(), { headers: sbHeaders(false) });
  return r.ok ? r.json() : [];
}

/* ----------------------- SIZING HELPERS ----------------------- */
async function fetchSizeChart() {
  const u = new URL(`${SUPABASE_URL}/rest/v1/size_chart`);
  u.searchParams.set('select', '*');
  u.searchParams.set('order', 'bust_min.asc');
  const r = await fetch(u.toString(), { headers: sbHeaders(false) });
  return r.ok ? r.json() : [];
}

function recommendSizeFromChart(chart, { bust, waist, hip }) {
  // score by how many measures fall inside a size range; tie-break by smallest upsizing
  const scored = chart.map(row => {
    let inside = 0, upsizes = 0;
    if (bust > 60) { bust *= 0.3937; waist *= 0.3937; hip *= 0.3937; }
    if (bust) { if (bust >= row.bust_min && bust <= row.bust_max) inside++; else if (bust > row.bust_max) upsizes++; }
    if (waist){ if (waist>= row.waist_min&& waist<= row.waist_max) inside++; else if (waist> row.waist_max) upsizes++; }
    if (hip)  { if (hip  >= row.hip_min  && hip  <= row.hip_max ) inside++; else if (hip  > row.hip_max ) upsizes++; }
    const penalty = upsizes; // prefer sizes that don't need upsizing
    return { row, score: inside, penalty };
  });
  scored.sort((a,b)=> b.score - a.score || a.penalty - b.penalty);
  return scored[0]?.row || null;
}

/* ----------------------- INTENT ----------------------- */
function intent(message) {
  const m = message.toLowerCase();
  // If measurements are present, force sizing intent
  if (hasMeasurements(message)) return 'sizing';

  if (/(deliver|shipping|when.*arrive|how long|days.*reach)/i.test(m)) return 'delivery';
  if (/(return|exchange|refund)/i.test(m)) return 'returns';
  if (/(size|sizing|size\s*chart|measure|fit)/i.test(m)) return 'sizing';
  if (/(order(ing)?|how to buy|checkout)/i.test(m)) return 'ordering';
  if (/(payment|cod|upi|card)/i.test(m)) return 'payments';
  if (/(offer|discount|promo|coupon|sale|clearance)/i.test(m)) return 'promo';
  if (/(contact|support|help|whatsapp|email)/i.test(m)) return 'contact';
  return 'general';
}

/* ----------------------- BRAND ANSWERS ----------------------- */
function answerFromBrand(i) {
  switch (i) {
    case 'delivery':
      return `Here’s how delivery works with ${BRAND.name}:
- **Dispatch:** ${BRAND.delivery.dispatch}
- **Timeline:** ${BRAND.delivery.timeframe}
- **Method:** ${BRAND.delivery.express}
- **Tracking:** ${BRAND.delivery.tracking}
Share your city/pincode and I’ll estimate more precisely.`;
    case 'returns':
      return `Exchanges are simple:
- ${BRAND.returns.policy}
- ${BRAND.returns.how}
Tell me your order number and what you’d like to change.`;
    case 'ordering':
      return `Ordering on ${BRAND.name}:
- ${BRAND.ordering.steps.join('\n- ')}
Need help at any step? I’m here.`;
    case 'payments':
      return `${BRAND.payments}
If you face any issue at payment, tell me the screen/error and I’ll help.`;
    case 'promo':
      return `Good news:
- ${BRAND.promo.desc}
- ${BRAND.clearance}
Want me to pull bestsellers you can apply **${BRAND.promo.code}** to?`;
    case 'contact':
      return `${BRAND.contact}`;
    default:
      return `${BRAND.whatWeDo}
Fabric: ${BRAND.materials}
Fit: ${BRAND.fit}
What are you shopping for today (style/coverage/size)? I’ll recommend options.`;
  }
}

/* ----------------------- POLISH (owner voice) ----------------------- */
async function polish(message, context) {
  const sys = `You are MEGHA, the official ${BRAND.name} assistant. Tone: ${BRAND.tone}.
Speak as the brand owner. Never mention sources or third parties. No generic delivery tiers.
Prefer tight paragraphs and bullet points. End with a short CTA.`;

  const user = `Customer: ${message}

Brand context:
${context}

Write a short, specific reply in MEGASKA’s voice. If about delivery, say 3–5 working days across India and 1 business day dispatch. If about promo, mention code ${BRAND.promo.code}. End with a helpful CTA.`;

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.15
      })
    });
    if (!r.ok) return context;
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || context;
  } catch {
    return context;
  }
}
// === SIZING PARSE & UNIT DETECT ===
function hasMeasurements(msg) {
  return /(bust|chest)\s*\d{2,3}|waist\s*\d{2,3}|hip[s]?\s*\d{2,3}/i.test(msg);
}

function parseMeasurements(msg) {
  // capture numbers near keywords (order independent)
  const m = {
    bust:  (msg.match(/(?:bust|chest)[^\d]{0,6}(\d{2,3})/i)  || [])[1],
    waist: (msg.match(/waist[^\d]{0,6}(\d{2,3})/i)          || [])[1],
    hip:   (msg.match(/hips?[^\d]{0,6}(\d{2,3})/i)          || [])[1]
  };
  let bust = m.bust ? +m.bust : null;
  let waist = m.waist ? +m.waist : null;
  let hip = m.hip ? +m.hip : null;

  // unit detection: if any value looks like cm (>= 60), convert all present to inches
  const looksCm = [bust, waist, hip].some(v => v && v >= 60);
  if (looksCm) {
    const toIn = v => (v ? +(v * 0.393700787).toFixed(1) : v);
    bust = toIn(bust); waist = toIn(waist); hip = toIn(hip);
  }
  return { bust, waist, hip, unit: looksCm ? 'cm' : 'in' };
}

function formatInches(v) { return v ? `${v}"` : '—'; }

function explainChoice(row, { bust, waist, hip }) {
  const lines = [];
  const check = (name, val, lo, hi) => {
    if (!val) return;
    if (val < lo) lines.push(`• Your ${name} (${val}") is a bit **below** ${row.size} range ${lo}–${hi}". Consider one size **down** only if you prefer snug fits.`);
    else if (val > hi) lines.push(`• Your ${name} (${val}") is **above** ${row.size} range ${lo}–${hi}". Consider one size **up** for comfort.`);
    else lines.push(`• Your ${name} (${val}") sits **inside** ${row.size} range ${lo}–${hi}".`);
  };
  check('bust', bust, row.bust_min, row.bust_max);
  check('waist', waist, row.waist_min, row.waist_max);
  check('hips', hip, row.hip_min, row.hip_max);
  return lines.join('\n');
}

/* ----------------------- HTTP HANDLER ----------------------- */
export default async function handler(req) {
  const h = cors(req);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (req.method === 'GET')     return json({ ok: true, route: '/api/chat', version: 'megha-fastpath-v2', ts: Date.now() }, 200, h);
  if (req.method !== 'POST')    return json({ ok: false, error: 'Method not allowed' }, 405, h);

  try {
    // Inside /api/chat.js, POST branch:
const body = await req.json().catch(() => ({}));

// Accept BOTH {message: "..."} and {messages:[{role,content}, ...]}
let message = body?.message;
if (!message && Array.isArray(body?.messages)) {
  // combine assistant/user contents; prefer latest user
  const lastUser = [...body.messages].reverse().find(m => m?.role === 'user');
  message = lastUser?.content || body.messages.map(m => m?.content || '').join('\n').trim();
}

// final validation
if (!message || typeof message !== 'string' || !message.trim()) {
  return json({ ok: false, error: "Missing 'message' string or empty content" }, 400, h);
}


    // 1) Intent
    const i = intent(message);

    // 2) Base answer
    let base = answerFromBrand(i);

    // 2a) Sizing special flow (ask for measurements + compute recommendation if present)
    if (i === 'sizing') {
  const chart = await fetchSizeChart();
  const { bust, waist, hip, unit } = parseMeasurements(message);

  // If user didn’t give numbers → ask for them, do not show products
  if (!bust && !waist && !hip) {
    const ask = `Let's get your best **MEGASKA brand size**:
- Share **bust / waist / hips** (you can type like: "bust 36, waist 32, hips 38").
- We accept **inches** or **cm** (we’ll detect it).  
If between sizes, choose the **larger** for a modest, comfy fit.`;
    base = ask;
    // prevent product suggestions for pure sizing flow:
    return json({ ok: true, reply: await polish(message, base) }, 200, h);
  }

  // We have numbers → recommend a size
  const pick = recommendSizeFromChart(chart, { bust, waist, hip });
  if (pick) {
    const explain = explainChoice(pick, { bust, waist, hip });
    base =
`Based on your measurements (${unit} detected, converted to inches for matching):
- **Bust:** ${formatInches(bust)}  | **Waist:** ${formatInches(waist)} | **Hips:** ${formatInches(hip)}

Your best MEGASKA **brand size is: ${pick.size}**.

${explain || ''}

Tip: Prefer a **relaxed** feel? Take one size **up**. Want **snug/active** fit? Stay with ${pick.size}.
Need help picking a style (full-length Islamic, knee-length, dress type, tops/bottoms)? Tell me your preference and I’ll suggest styles.`;
  } else {
    base = `Thanks! Your numbers sit across multiple ranges. If you share a photo or tell me your **fit preference** (snug / relaxed), I’ll fine-tune the size. Otherwise choose the **larger** size for swim comfort.`;
  }

  // IMPORTANT: Don’t attach product/collection links in a sizing-only reply
  const reply = await polish(message, base);
  return json({ ok: true, reply }, 200, h);
}

    // 3) Quick enrichment (keyword first)
    let extra = '';
    try {
      const term = i === 'delivery' ? 'shipping' : i;
      const [pHits, cHits] = await Promise.all([kwPages(term, 4), kwChunks(term, 6)]);
      const snippets = (cHits || []).slice(0, 3).map(x => (x.content || '').slice(0, 300));
      if (snippets.length) extra = `\n\n${snippets.join('\n\n')}`;
    } catch { /* ignore */ }

    // 4) If still thin and the question is long/specific, try embeddings briefly
    if (!extra && message.length > 30) {
      try {
        const qemb = await embed(message);
        const matches = await matchChunks(qemb, 8, 0.64);
        const enrich = (matches || []).slice(0, 3).map(m => (m.content || '').slice(0, 300)).join('\n\n');
        if (enrich) extra = `\n\n${enrich}`;
      } catch { /* ignore */ }
    }

    // 5) Product/Collection quick links + external links (Amazon/Myntra) when relevant
    let linkBlock = '';
try {
  if (/(show|find|see|price|cost|buy|link|product|collection|burkini|dress|rash|one[- ]?piece|swim)/i.test(message)) {
    let hits = await shopifySearchProducts(message, 4);
    if (!hits.length) hits = await findProductsAndCollections(message, 4); // fallback to your indexed pages
    if (hits.length) {
      linkBlock += '\n\n**Quick links:**\n' + hits.map(h => `- [${h.title || 'View'}](${h.url})`).join('\n');
    }
    const exts = await extLinks(message, 3);
    if (exts.length) {
      linkBlock += '\n\n**Also available on:**\n' + exts.map(e => `- ${e.store}: [${e.label}](${e.url})`).join('\n');
    }
  }
} catch {}

    // 6) Final polish (owner voice)
    const reply = await polish(message, `${base}${extra}${linkBlock}`.trim());

    return json({ ok: true, reply }, 200, h);
  } catch (e) {
    return json({ ok: false, error: e?.message || String(e) }, 500, h);
  }
}
