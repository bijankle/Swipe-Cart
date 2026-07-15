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
 * group 1. opts go straight to scrape.do (e.g. super/render for hard sites).
 */
const SOURCES = [
  { site: "Etsy", base: "https://www.etsy.com", category: "home", tags: ["handmade", "artisan", "cozy"],
    search: "https://www.etsy.com/search?q=ceramic+table+lamp", linkRe: /href="(https:\/\/www\.etsy\.com\/listing\/\d+[^"#]*)"/g },
  { site: "Etsy", base: "https://www.etsy.com", category: "stationery", tags: ["handmade", "creative", "ritual"],
    search: "https://www.etsy.com/search?q=dot+grid+journal", linkRe: /href="(https:\/\/www\.etsy\.com\/listing\/\d+[^"#]*)"/g },
  { site: "REI", base: "https://www.rei.com", category: "outdoors", tags: ["outdoorsy", "adventure", "durable"],
    search: "https://www.rei.com/search?q=camping+hammock", linkRe: /href="(\/product\/\d+[^"#]*)"/g },
  { site: "REI", base: "https://www.rei.com", category: "travel", tags: ["adventure", "practical", "organized"],
    search: "https://www.rei.com/search?q=travel+backpack+carry+on", linkRe: /href="(\/product\/\d+[^"#]*)"/g },
  { site: "REI", base: "https://www.rei.com", category: "footwear", tags: ["outdoorsy", "sporty", "durable"],
    search: "https://www.rei.com/search?q=trail+running+shoes", linkRe: /href="(\/product\/\d+[^"#]*)"/g },
  { site: "ASOS", base: "https://www.asos.com", category: "fashion", tags: ["streetwear", "trending", "casual"],
    search: "https://www.asos.com/us/search/?q=linen+shirt", linkRe: /href="([^"]*\/prd\/\d+[^"#]*)"/g },
  { site: "Chewy", base: "https://www.chewy.com", category: "pets", tags: ["pet-parent", "cozy", "practical"],
    search: "https://www.chewy.com/s?query=orthopedic+dog+bed", linkRe: /href="(\/[a-z0-9-]+\/dp\/\d+[^"#]*)"/g },
  { site: "Best Buy", base: "https://www.bestbuy.com", category: "tech", tags: ["techy", "commute", "minimalist"],
    search: "https://www.bestbuy.com/site/searchpage.jsp?st=noise+cancelling+headphones", linkRe: /href="(\/site\/[a-z0-9-]+\/\d+\.p[^"#]*)"/g },
  { site: "Best Buy", base: "https://www.bestbuy.com", category: "gaming", tags: ["techy", "battle-station", "comfort"],
    search: "https://www.bestbuy.com/site/searchpage.jsp?st=gaming+chair", linkRe: /href="(\/site\/[a-z0-9-]+\/\d+\.p[^"#]*)"/g },
  { site: "Crate & Barrel", base: "https://www.crateandbarrel.com", category: "kitchen", tags: ["heirloom", "practical", "artisan"],
    search: "https://www.crateandbarrel.com/search?query=dutch+oven", linkRe: /href="(\/[a-z0-9-]+\/s\d+[^"#]*)"/g },
  { site: "Nordstrom", base: "https://www.nordstrom.com", category: "beauty", tags: ["skincare", "glow", "self-care"],
    search: "https://www.nordstrom.com/sr?keyword=vitamin+c+serum", linkRe: /href="(\/s\/[a-z0-9-]+\/\d+[^"#]*)"/g },
  { site: "Amazon", base: "https://www.amazon.com", category: "fitness", tags: ["home-gym", "wellness", "practical"],
    search: "https://www.amazon.com/s?k=cork+yoga+mat", linkRe: /href="(\/[^"]*\/dp\/[A-Z0-9]{10}[^"#]*)"/g,
    opts: { super: "true", geoCode: "us" } },
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
    html = await scrape(src.search, src.opts);
  } catch (err) {
    console.error(`[${label}] search failed: ${err.message}`);
    continue;
  }
  const links = productLinks(html, src);
  console.log(`[${label}] ${links.length} product links found`);
  if (!links.length && DEBUG_ONE) {
    console.log(`[${label}] page sample: ${html.slice(0, 400).replace(/\s+/g, " ")}`);
  }

  const want = DEBUG_ONE ? 1 : PER_SOURCE;
  let kept = 0;
  for (const link of links) {
    if (kept >= want) break;
    try {
      const page = await scrape(link, src.opts);
      const ld = findProductLd(page);
      if (!ld) {
        console.log(`[${label}] no Product JSON-LD at ${link}`);
        continue;
      }
      if (DEBUG_ONE) console.log(`[${label}] LD keys: ${Object.keys(ld).join(", ")}`);
      const p = mapLdProduct(ld, link, src);
      if (!p) {
        console.log(`[${label}] LD present but unmappable (title/image/price) at ${link}`);
        continue;
      }
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
