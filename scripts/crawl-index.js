import fetch from "node-fetch";
import cheerio from "cheerio";
import OpenAI from "openai";
import { getPool } from "../lib/db.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function fetchText(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`Fetch ${url} ${r.status}`);
  return r.text();
}

function isSitemapIndex(xml) {
  return /<sitemapindex/i.test(xml);
}
function parseXmlTagList(xml, tag) {
  const re = new RegExp(`<${tag}>(.*?)</${tag}>`, "gis");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

async function getSitemapUrls(sitemapUrl) {
  const xml = await fetchText(sitemapUrl);
  let urls = [];
  if (isSitemapIndex(xml)) {
    const sitemaps = parseXmlTagList(xml, "loc");
    for (const sm of sitemaps) {
      const childXml = await fetchText(sm);
      urls.push(...parseXmlTagList(childXml, "loc"));
      await sleep(100);
    }
  } else {
    urls = parseXmlTagList(xml, "loc");
  }
  // filter to site domain if needed
  return Array.from(new Set(urls));
}

function textFromHtml(html) {
  const $ = cheerio.load(html);
  $("script,style,noscript").remove();
  const title = $("title").first().text().trim();
  const body = $("body").text().replace(/\s+/g, " ").trim();
  return { title, text: body };
}

function chunkText(text, maxLen = 1200, overlap = 150) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + maxLen);
    const slice = text.slice(i, end);
    chunks.push(slice);
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks.filter(c => c.trim().length > 0);
}

async function embedBatch(strings) {
  if (!strings.length) return [];
  const resp = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: strings
  });
  return resp.data.map(d => d.embedding);
}

async function upsertPage(pool, url, title, status) {
  await pool.query(
    `INSERT INTO web_pages (url, title, status, fetched_at)
     VALUES ($1,$2,$3,NOW())
     ON CONFLICT (url) DO UPDATE SET title=EXCLUDED.title,status=EXCLUDED.status,fetched_at=NOW()`,
    [url, title, status]
  );
}

async function upsertChunks(pool, url, chunks, embeddings) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM web_chunks WHERE url=$1", [url]);
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO web_chunks (url, chunk_index, content, embedding)
         VALUES ($1,$2,$3,$4)`,
        [url, i, chunks[i], embeddings[i]]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function crawl(sitemapUrl) {
  const pool = getPool();
  const urls = await getSitemapUrls(sitemapUrl);
  console.log(`Found ${urls.length} URLs`);
  let count = 0;

  for (const url of urls) {
    try {
      const res = await fetch(url);
      const status = res.status;
      const html = await res.text();
      const { title, text } = textFromHtml(html);
      const chunks = chunkText(text);

      const embeddings = await embedBatch(chunks);
      await upsertPage(pool, url, title, status);
      await upsertChunks(pool, url, chunks, embeddings);

      count++;
      console.log(`[${count}/${urls.length}] Indexed: ${url} (${chunks.length} chunks)`);
      await sleep(200);
    } catch (e) {
      console.error(`Failed ${url}:`, e.message);
    }
  }
  await pool.end();
}

const sitemapArg = process.argv[2] || "https://megaska.com/sitemap.xml";
crawl(sitemapArg).catch(e => { console.error(e); process.exit(1); });
