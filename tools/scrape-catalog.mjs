/**
 * Build catalog products by scraping real retailer pages via scrape.do.
 *
 * Strategy: fetch a search/category page per source, harvest product-page
 * links, then parse each product page's schema.org JSON-LD (the SEO data
 * virtually every retailer embeds) — title, brand, image gallery,
 * description, price, rating, and the direct merchant URL.
 *
 * Env:
 *   SCRAPEDO_KEY          required — scrape.do token (repo secret)
 *   DEBUG_ONE=true        probe every source cheaply (search page + one
 *                         product page each), dump findings, write nothing
 *   PER_SOURCE            products to keep per source (default 6)
 *
 * Merges with the existing catalog.json: previous entries are kept unless
 * this run re-scrapes them; only interactive products ship.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OUT = new URL("../catalog.json", import.meta.url).pathname;
const KEY = process.env.SCRAPEDO_KEY;
const DEBUG_ONE = process.env.DEBUG_ONE === "true";
const PER_SOURCE = Math.max(1, Number(process.env.PER_SOURCE ?? 6));

if (!KEY) {
  console.error("SCRAPEDO_KEY is not set.");
  process.exit(1);
}

/**
 * One entry per retailer search — linkRe must capture the product path in
 * group 1. searchOpts/pageOpts go to scrape.do per request type (super =
 * residential proxy 10cr, render = headless browser 5cr; both add up).
 * `keep` overrides PER_SOURCE for expensive sources.
 *
 * Probe results (2026-07-15): Crate & Barrel works on 1cr requests with
 * full JSON-LD; Etsy/REI block datacenter IPs (super needed); ASOS/Chewy
 * render their grids client-side (render needed on search); Best Buy is
 * server-rendered but with absolute link URLs; Amazon has no JSON-LD, so
 * it gets a dedicated HTML parser; Nordstrom wants super+render (25cr/page)
 * and was dropped as not worth it.
 */
const SOURCES = [
  { site: "Crate & Barrel", base: "https://www.crateandbarrel.com", category: "kitchen", tags: ["heirloom", "practical", "artisan"],
    search: "https://www.crateandbarrel.com/search?query=dutch+oven", linkRe: /href="((?:https:\/\/www\.crateandbarrel\.com)?\/[a-z0-9-]+\/s\d+)[^"]*"/g },
  { site: "Crate & Barrel", base: "https://www.crateandbarrel.com", category: "home", tags: ["modern", "minimalist", "warm-light"],
    search: "https://www.crateandbarrel.com/search?query=table+lamp", linkRe: /href="((?:https:\/\/www\.crateandbarrel\.com)?\/[a-z0-9-]+\/s\d+)[^"]*"/g },
  { site: "Best Buy", base: "https://www.bestbuy.com", category: "tech", tags: ["techy", "commute", "minimalist"],
    search: "https://www.bestbuy.com/site/searchpage.jsp?st=noise+cancelling+headphones",
    linkRe: /href="(?:https:\/\/www\.bestbuy\.com)?(\/(?:site|product)\/[^"?#]+(?:\/\d+\.p|\.p))\b[^"]*"/g },
  { site: "Best Buy", base: "https://www.bestbuy.com", category: "gaming", tags: ["techy", "battle-station", "comfort"],
    search: "https://www.bestbuy.com/site/searchpage.jsp?st=gaming+chair",
    linkRe: /href="(?:https:\/\/www\.bestbuy\.com)?(\/(?:site|product)\/[^"?#]+(?:\/\d+\.p|\.p))\b[^"]*"/g },
  { site: "ASOS", base: "https://www.asos.com", category: "fashion", tags: ["streetwear", "trending", "casual"],
    search: "https://www.asos.com/us/search/?q=linen+shirt", linkRe: /href="([^"]*\/prd\/\d+)[^"]*"/g,
    searchOpts: { render: "true" } },
  { site: "Chewy", base: "https://www.chewy.com", category: "pets", tags: ["pet-parent", "cozy", "practical"],
    search: "https://www.chewy.com/s?query=orthopedic+dog+bed", linkRe: /href="((?:https:\/\/www\.chewy\.com)?\/[a-z0-9-]+\/dp\/\d+)[^"]*"/g,
    searchOpts: { render: "true" } },
  { site: "Etsy", base: "https://www.etsy.com", category: "stationery", tags: ["handmade", "creative", "ritual"],
    search: "https://www.etsy.com/search?q=dot+grid+journal", linkRe: /href="(https:\/\/www\.etsy\.com\/listing\/\d+)[^"]*"/g,
    searchOpts: { super: "true", geoCode: "us" }, pageOpts: { super: "true", geoCode: "us" }, keep: 4 },
  { site: "REI", base: "https://www.rei.com", category: "outdoors", tags: ["outdoorsy", "adventure", "durable"],
    search: "https://www.rei.com/search?q=camping+hammock", linkRe: /href="((?:https:\/\/www\.rei\.com)?\/product\/\d+[^"?#]*)"/g,
    searchOpts: { super: "true", geoCode: "us" }, pageOpts: { super: "true", geoCode: "us" }, keep: 4 },
  { site: "Amazon", base: "https://www.amazon.com", category: "fitness", tags: ["home-gym", "wellness", "practical"],
    search: "https://www.amazon.com/s?k=cork+yoga+mat", linkRe: /href="(\/[^"]*\/dp\/[A-Z0-9]{10})[^"]*"/g,
    searchOpts: { super: "true", geoCode: "us" }, pageOpts: { super: "true", geoCode: "us" }, keep: 3 },
];

const CATEGORY_EMOJI = {
  fashion: "🧥", footwear: "👟", tech: "🎧", home: "🛋", kitchen: "🍳",
  fitness: "🏋", beauty: "🧴", outdoors: "🏕", gaming: "🎮", pets: "🐕",
  stationery: "📓", travel: "🎒",
};

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

async function scrape(url, opts = {}) {
  const qs = new URLSearchParams({ token: KEY, url, ...opts });
  const res = await fetch(`https://api.scrape.do/?${qs}`);
  const body = await res.text();
  if (!res.ok) throw new Error(`scrape.do HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
  return body;
}

const decodeEntities = (s) =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** All JSON-LD blocks in a page, flattened through @graph. */
function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { blocks.push(JSON.parse(m[1].trim())); } catch { /* malformed block */ }
  }
  return blocks.flatMap((b) => (Array.isArray(b) ? b : b?.["@graph"] ?? [b])).filter(Boolean);
}

function findProductLd(html) {
  return jsonLdBlocks(html).find((b) => {
    const t = b["@type"];
    return t === "Product" || (Array.isArray(t) && t.includes("Product"));
  });
}

function ldImages(image) {
  const arr = Array.isArray(image) ? image : image ? [image] : [];
  return [...new Set(arr.map((i) => (typeof i === "string" ? i : i?.url ?? i?.contentUrl)).filter(Boolean).map(String))];
}

function ldPrice(offers) {
  const o = Array.isArray(offers) ? offers[0] : offers;
  if (!o) return NaN;
  return Number(o.price ?? o.lowPrice ?? o.highPrice ?? (o.priceSpecification?.price));
}

function mapLdProduct(ld, pageUrl, src) {
  const images = ldImages(ld.image).slice(0, 8);
  const price = ldPrice(ld.offers);
  const title = ld.name && decodeEntities(ld.name);
  if (!title || !images.length || !Number.isFinite(price) || price <= 0) return null;

  const rating = ld.aggregateRating?.ratingValue;
  const reviews = ld.aggregateRating?.reviewCount ?? ld.aggregateRating?.ratingCount;
  const specs = Array.isArray(ld.additionalProperty)
    ? ld.additionalProperty
        .map((a) => ({ name: String(a.name ?? "").slice(0, 60), value: String(a.value ?? "").slice(0, 200) }))
        .filter((a) => a.name && a.value).slice(0, 40)
    : [];

  return {
    id: `s-${hash(pageUrl)}`,
    title: title.slice(0, 90),
    brand: decodeEntities(ld.brand?.name ?? (typeof ld.brand === "string" ? ld.brand : "")).slice(0, 40),
    platform: src.site,
    category: src.category,
    price: Math.round(price),
    tags: src.tags,
    emoji: CATEGORY_EMOJI[src.category] ?? "🛍",
    hue: hash(title) % 360,
    blurb: rating ? `${Number(rating).toFixed(1)}★${reviews ? ` (${Number(reviews).toLocaleString("en-US")} reviews)` : ""}` : "",
    image: images[0],
    images,
    url: pageUrl,
    ...(decodeEntities(ld.description ?? "") ? { description: decodeEntities(ld.description).slice(0, 700) } : {}),
    ...(specs.length ? { specs } : {}),
  };
}

/** Amazon embeds product data in HTML/JS blobs instead of JSON-LD. */
function amazonProduct(html, pageUrl, src) {
  const title = decodeEntities(html.match(/id="productTitle"[^>]*>\s*([^<]+)/)?.[1] ?? "");
  const price = Number(
    html.match(/"priceAmount":\s*([\d.]+)/)?.[1]
    ?? html.match(/class="a-offscreen">\$([\d,]+(?:\.\d+)?)</)?.[1]?.replace(/,/g, ""),
  );
  const hiRes = [...html.matchAll(/"hiRes":"(https:[^"]+?)"/g)].map((m) => m[1]);
  const large = [...html.matchAll(/"large":"(https:[^"]+?)"/g)].map((m) => m[1]);
  const images = [...new Set(hiRes.length ? hiRes : large)].slice(0, 8);
  if (!title || !images.length || !Number.isFinite(price) || price <= 0) return null;

  const bullets = html.match(/id="feature-bullets"[\s\S]{0,6000}?<\/ul>/)?.[0] ?? "";
  const features = [...bullets.matchAll(/<span class="a-list-item">\s*([\s\S]+?)\s*<\/span>/g)]
    .map((m) => decodeEntities(m[1])).filter((t) => t.length > 5 && t.length < 300).slice(0, 8);
  const rating = html.match(/([\d.]+) out of 5 stars/)?.[1];
  const reviews = html.match(/([\d,]+) ratings/)?.[1];
  const brand = decodeEntities(html.match(/id="bylineInfo"[^>]*>([^<]+)/)?.[1] ?? "")
    .replace(/^(Visit the |Brand: )/, "").replace(/ Store$/, "").trim();

  return {
    id: `s-${hash(pageUrl)}`,
    title: title.slice(0, 90),
    brand: brand.slice(0, 40),
    platform: src.site,
    category: src.category,
    price: Math.round(price),
    tags: src.tags,
    emoji: CATEGORY_EMOJI[src.category] ?? "🛍",
    hue: hash(title) % 360,
    blurb: rating ? `${rating}★${reviews ? ` (${reviews} ratings)` : ""}` : "",
    image: images[0],
    images,
    url: pageUrl.split("/ref=")[0],
    ...(features.length ? { features } : {}),
  };
}

/** OpenGraph fallback for stores without Product JSON-LD. */
function ogProduct(html, pageUrl, src) {
  const meta = (prop) =>
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)`, "i"))?.[1]
    ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"))?.[1];
  const title = meta("og:title") && decodeEntities(meta("og:title"));
  const images = [...new Set(
    [...html.matchAll(/<meta[^>]+(?:property|name)=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)/gi)].map((m) => m[1]),
  )].slice(0, 8);
  const price = Number(meta("product:price:amount") ?? meta("og:price:amount") ?? meta("twitter:data1")?.replace(/[^0-9.]/g, ""));
  if (!title || !images.length || !Number.isFinite(price) || price <= 0) return null;
  const desc = meta("og:description") && decodeEntities(meta("og:description"));

  return {
    id: `s-${hash(pageUrl)}`,
    title: title.slice(0, 90),
    brand: "",
    platform: src.site,
    category: src.category,
    price: Math.round(price),
    tags: src.tags,
    emoji: CATEGORY_EMOJI[src.category] ?? "🛍",
    hue: hash(title) % 360,
    blurb: "",
    image: images[0],
    images,
    url: pageUrl,
    ...(desc ? { description: desc.slice(0, 700) } : {}),
  };
}

function productLinks(html, src) {
  const links = new Set();
  let m;
  src.linkRe.lastIndex = 0;
  while ((m = src.linkRe.exec(html)) && links.size < 40) {
    let href = decodeEntities(m[1]).split("?")[0];
    if (href.startsWith("/")) href = src.base + href;
    if (href.startsWith("http")) links.add(href);
  }
  return [...links];
}

const isInteractive = (p) => p.specs?.length || (p.images?.length ?? 0) > 1 || p.description;

const results = [];
for (const src of SOURCES) {
  const label = `${src.site} · ${src.category}`;
  let html;
  try {
    html = await scrape(src.search, src.searchOpts);
  } catch (err) {
    console.error(`[${label}] search failed: ${err.message}`);
    continue;
  }
  const links = productLinks(html, src);
  console.log(`[${label}] ${links.length} product links found`);
  if (!links.length && DEBUG_ONE) {
    console.log(`[${label}] page sample: ${html.slice(0, 400).replace(/\s+/g, " ")}`);
  }

  const want = DEBUG_ONE ? 1 : Math.min(PER_SOURCE, src.keep ?? PER_SOURCE);
  // Hard attempt cap — every fetched page is billed whether or not it maps.
  const attempts = links.slice(0, DEBUG_ONE ? 2 : want * 2);
  let kept = 0;
  for (const link of attempts) {
    if (kept >= want) break;
    try {
      const page = await scrape(link, src.pageOpts);
      const ld = findProductLd(page);
      let p = ld ? mapLdProduct(ld, link, src) : null;
      if (!p && src.site === "Amazon") p = amazonProduct(page, link, src);
      if (!p) p = ogProduct(page, link, src);
      if (!p) {
        console.log(`[${label}] unmappable (no LD/amazon/og data) at ${link}`);
        continue;
      }
      if (DEBUG_ONE && ld) console.log(`[${label}] LD keys: ${Object.keys(ld).join(", ")}`);
      if (DEBUG_ONE) console.log(`[${label}] mapped: "${p.title}" $${p.price} · ${p.images.length} photos · specs ${p.specs?.length ?? 0} · desc ${p.description ? "yes" : "no"} · interactive ${isInteractive(p) ? "YES" : "no"}`);
      results.push(p);
      kept++;
    } catch (err) {
      console.error(`[${label}] product failed: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 500));
}

if (DEBUG_ONE) {
  console.log(`DEBUG_ONE: ${results.length}/${SOURCES.length} sources produced a mapped product — not writing catalog.json`);
  process.exit(0);
}

const fresh = results.filter(isInteractive);
console.log(`${results.length} scraped, ${fresh.length} interactive`);

// Merge: keep existing catalog entries not re-scraped this run.
let existing = [];
if (existsSync(OUT)) {
  try { existing = JSON.parse(readFileSync(OUT, "utf8")).products ?? []; } catch {}
}
const freshIds = new Set(fresh.map((p) => p.id));
const merged = [...existing.filter((p) => !freshIds.has(p.id)), ...fresh];

if (fresh.length < 5) {
  console.error(`Only ${fresh.length} interactive products scraped — refusing to rewrite the catalog.`);
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: merged.length, products: merged }, null, 1));
console.log(`catalog.json written: ${merged.length} products (${fresh.length} new/updated from scrape.do)`);
