// /api/chat.js — MEGASKA Smart Fast Path (Edge, brand-grounded, no sources)
export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const OPENAI_KEY   = process.env.OPENAI_API_KEY;

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
  sizing: {
    chart:
      "We provide clear size guidance. Measure bust/waist/hip; if between sizes, choose the larger for comfort.",
    help:
      "Share height, weight, usual top/bottom size, and fit preference (snug/regular/modest) for a precise recommendation."
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
  contact:
    "Reply to your order message or use the site contact—share your order number for quickest help.",
  promo: {
    code: "MEGA15",
    desc: "Use code MEGA15 for 15% off on all orders."
  },
  clearance:
    "We’re running a clearance sale on shapewear and sleepwear collections—limited sizes while stocks last."
};

/* ----------------------- UTILS ----------------------- */
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }
  });

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

/* ----------------------- QUICK KEYWORD SEARCH ----------------------- */
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

/* ----------------------- INTENT ----------------------- */
function intent(message) {
  const m = message.toLowerCase();
  if (/(deliver|shipping|when.*arrive|how long|days.*reach)/i.test(m)) return 'delivery';
  if (/(return|exchange|refund)/i.test(m)) return 'returns';
  if (/(size|sizing|size\s*chart|measure)/i.test(m)) return 'sizing';
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
    case 'sizing':
      return `Let’s get your size right:
- ${BRAND.sizing.chart}
- ${BRAND.sizing.help}
Tell me height, weight, usual sizes, and fit preference—I'll recommend a size.`;
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

/* ----------------------- HTTP HANDLER ----------------------- */
export default async function handler(req) {
  const h = cors(req);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (req.method === 'GET')     return json({ ok: true, route: '/api/chat', version: 'megha-fastpath-v1', ts: Date.now() }, 200, h);
  if (req.method !== 'POST')    return json({ ok: false, error: 'Method not allowed' }, 405, h);

  try {
    const { message } = await req.json().catch(() => ({}));
    if (!message || typeof message !== 'string') {
      return json({ ok: false, error: "Missing 'message' string" }, 400, h);
    }

    // 1) Fast intent answer from Brand Brain
    const i = intent(message);
    let base = answerFromBrand(i);

    // 2) Quick enrichment (keyword first)
    let extra = '';
    try {
      const term = i === 'delivery' ? 'shipping' : i;
      const [pHits, cHits] = await Promise.all([kwPages(term, 4), kwChunks(term, 6)]);
      const snippets = (cHits || []).slice(0, 3).map(x => (x.content || '').slice(0, 300));
      if (snippets.length) extra = `\n\n${snippets.join('\n\n')}`;
    } catch {
      // ignore
    }

    // 3) If still thin and the question is long/specific, try embeddings briefly
    if (!extra && message.length > 30) {
      try {
        const qemb = await embed(message);
        const matches = await matchChunks(qemb, 8, 0.64);
        const enrich = (matches || []).slice(0, 3).map(m => (m.content || '').slice(0, 300)).join('\n\n');
        if (enrich) extra = `\n\n${enrich}`;
      } catch {
        // ignore
      }
    }

    // 4) Final polish (owner voice)
    const reply = await polish(message, `${base}${extra}`.trim());

    return json({ ok: true, reply }, 200, h);
  } catch (e) {
    return json({ ok: false, error: e?.message || String(e) }, 500, h);
  }
}
