// ==========================================
// Megaska Chat — Website Crawler & Indexer
// ==========================================
// Usage:
//   npm run crawl:index -- "https://megaska.com/sitemap.xml"
// ------------------------------------------

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";
import crypto from "crypto";
import cheerio from "cheerio";
import "dotenv/config";

// -------------------------------
//  CONFIGURATION
// -------------------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const SITE =
  process.argv.find((a) => a.startsWith("http")) ||
  process.env.SITEMAP_URL ||
  "https://megaska.com/sitemap.xml";

const MAX_URLS = parseInt(process.env.MAX_URLS || "2000", 10);
const CONCURRENCY = 3; // how many pages crawl at once
const EMBEDDING_MODEL = "text-embedding-3-small";

// -------------------------------
//  UTILITIES
// -------------------------------
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

// -------------------------------
//  FETCH & PARSE SITEMAP
// -------------------------------
async function getSitemapUrls(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch sitemap: ${url}`);
  const xml = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const parsed = parser.parse(xml);

  let urls = [];

  if (parsed.sitemapindex && parsed.sitemapindex.sitemap) {
    const sitemaps = Array.isArray(parsed.sitemapindex.sitemap)
      ? parsed.sitemapindex.sitemap
      : [parsed.sitemapindex.sitemap];
    for (const sm of sitemaps) {
      if (sm.loc) {
        const childUrls = await getSitemapUrls(sm.loc);
        urls.push(...childUrls);
      }
    }
  } else if (parsed.urlset && parsed.urlset.url) {
    const items = Array.isArray(parsed.urlset.url)
      ? parsed.urlset.url
      : [parsed.urlset.url];
    urls = items.map((u) => u.loc).filter(Boolean);
  }

  return Array.from(new Set(urls)).slice(0, MAX_URLS);
}

// -------------------------------
//  EMBEDDING + UPSERT
// -------------------------------
async function embedBatch(strings) {
  if (!strings.length) return [];
  const resp = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
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

// -------------------------------
//  CRAWL ONE PAGE
// -------------------------------
async function crawlOne(url, index, total) {
  try {
    const res = await fetch(url);
    const html = await res.text();
    const { title, text } = cleanHtml(html);

    if (!text || text.length < 50) {
      console.log(`[${index + 1}/${total}] Skipped (too short): ${url}`);
      return;
    }

    const chunks = chunkText(text);
    const embeddings = await embedBatch(chunks);

    await upsertPage(url, title, res.status);
    await upsertChunks(url, chunks, embeddings);

    console.log(`[${index + 1}/${total}] Indexed: ${url} (${chunks.length} chunks)`);
    await sleep(200);
  } catch (err) {
    console.error(`[${index + 1}/${total}] Failed ${url}: ${err.message}`);
  }
}

// -------------------------------
//  SIMPLE CONCURRENCY POOL
// -------------------------------
async function asyncPool(limit, array, iteratorFn) {
  const ret = [];
  const execut
