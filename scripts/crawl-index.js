import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import cheerio from "cheerio";
import "dotenv/config";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SITE =
  process.argv.find((a) => a.startsWith("http")) ||
  process.env.SITEMAP_URL ||
  "https://megaska.com/sitemap.xml";

const MAX_URLS = 2000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunkText(text, maxLen = 1200, overlap = 150) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + maxLen);
    chunks.push(text.slice(i, end));
    i = end - overlap;
  }
  return chunks.filter((c) => c.trim().length > 0);
}

function cleanHtml(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const title = $("title").text().trim();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  return { title, text };
}

async function getSitemapUrls(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch sitemap: ${url}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const parsed = parser.parse(xml);
  let urls = [];

  if (parsed.sitemapindex?.sitemap) {
    const maps = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];
    for (const sm of maps) {
      if (sm.loc) urls.push(...(await getSitemapUrls(sm.loc)));
    }
  } else if (parsed.urlset?.url) {
    const items = Array.isArray(parsed.urlset.url)
      ? parsed.urlset.url
      : [parsed.urlset.url];
    urls = items.map((u) => u.loc).filter(Boolean);
  }
  return Array.from(new Set(urls)).slice(0, MAX_URLS);
}

async function embedBatch(strings) {
  if (!strings.length) return [];
  const resp = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: strings,
  });
  return resp.data.map((d) => d.embedding);
}

async function upsertPage(url, title, status) {
  await supabase
    .from("web_pages")
    .upsert({ url, title, status, fetched_at: new Date().toISOString() });
}

async function upsertChunks(url, chunks, embeddings) {
  const rows = chunks.map((content, i) => ({
    url,
    chunk_index: i,
    content,
    embedding: embeddings[i],
  }));
  await supabase.from("web_chunks").delete().eq("url", url);
  await supabase.from("web_chunks").insert(rows);
}

async function crawlOne(url, i, total) {
  try {
    const res = await fetch(url);
    const html = await res.text();
    const { title, text } = cleanHtml(html);
    if (!text || text.length < 50) {
      console.log(`[${i + 1}/${total}] Skipped: ${url}`);
      return;
    }
    const chunks = chunkText(text);
    const embeddings = await embedBatch(chunks);
    await upsertPage(url, title, res.status);
    await upsertChunks(url, chunks, embeddings);
    console.log(`[${i + 1}/${total}] Indexed: ${url}`);
    await sleep(200);
  } catch (err) {
    console.error(`[${i + 1}/${total}] Failed ${url}:`, err.message);
  }
}

async function run() {
  console.log(`Crawling: ${SITE}`);
  const urls = await getSitemapUrls(SITE);
  console.log(`Total URLs: ${urls.length}`);
  for (let i = 0; i < urls.length; i++) {
    await crawlOne(urls[i], i, urls.length);
  }
  console.log("✅ Crawl completed successfully!");
}

run().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
