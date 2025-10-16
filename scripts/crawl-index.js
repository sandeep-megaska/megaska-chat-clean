// =========================
// Megaska Chat Crawler v2
// =========================
// Sequential, stable, and works with Supabase + OpenAI Embeddings
// Usage: npm.cmd run crawl:index -- "https://megaska.com/sitemap.xml"

import fetch from "node-fetch";
import cheerio from "cheerio";
import OpenAI from "openai";
import { getPool } from "../lib/db.js";
import "dotenv/config";


// --- CONFIG ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MAX_URLS = parseInt(process.env.MAX_URLS || "2000", 10);
const SITEMAP_URL =
  process.argv[2] && process.argv[2].startsWith("http")
    ? process.argv[2]
    : "https://megaska.com/sitemap.xml";

// --- HELPERS ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${url}`);
  return res.text();
}

function isSitemapIndex(xml) {
  return /<sitemapindex/i.test(xml);
}

function extractXmlTagList(xml, tag) {
  const regex = new RegExp(`<${tag}>(.*?)</${tag}>`, "gis");
  const out = [];
  let match;
  while ((match = regex.exec(xml))) {
    out.push(match[1].trim());
  }
  return out;
}

async function getSitemapUrls(sitemapUrl) {
  const xml = await fetchText(sitemapUrl);
  let urls = [];

  if (isSitemapIndex(xml)) {
    const sitemaps = extractXmlTagList(xml, "loc");
    for (const sm of sitemaps) {
      try {
        const xml2 = await fetchText(sm);
        urls.push(...extractXmlTagList(xml2, "loc"));
        await sleep(100);
      } catch (e) {
        console.warn(`Failed child sitemap ${sm}: ${e.message}`);
      }
    }
  } else {
    urls = extractXmlTagList(xml, "loc");
  }

  return Array.from(new Set(urls)).slice(0,
