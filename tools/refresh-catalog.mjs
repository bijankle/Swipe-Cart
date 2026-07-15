/**
 * Refresh catalog.json with real products from Google Shopping via
 * SearchApi.io (https://www.searchapi.io/docs/google-shopping).
 *
 * Runs in the refresh-catalog workflow with SEARCHAPI_KEY from repo secrets.
 * Each query is themed so its style tags feed the taste engine the same
 * vocabulary the sample catalog uses. Field mapping is defensive — provider
 * schemas drift — and the first raw item is logged for debugging.
 *
 * Local/offline use: `node tools/refresh-catalog.mjs --fixture file.json`
 * maps a saved API response instead of calling the network.
 */

import { readFileSync, writeFileSync } from "node:fs";

const OUT = new URL("../catalog.json", import.meta.url).pathname;
const PER_QUERY = 15; // keep the deck a manageable size
const MIN_TOTAL = 30; // refuse to ship a suspiciously empty catalog

/** Themed queries — each burns one API credit per refresh. */
const QUERIES = [
  { q: "minimalist ceramic table lamp", category: "home", tags: ["minimalist", "modern", "warm-light"] },
  { q: "cozy chunky knit throw blanket", category: "home", tags: ["cozy", "soft", "hygge"] },
  { q: "retro mechanical keyboard", category: "tech", tags: ["retro", "techy", "desk-setup"] },
  { q: "wireless noise cancelling headphones", category: "tech", tags: ["techy", "commute", "minimalist"] },
  { q: "cork yoga mat", category: "fitness", tags: ["wellness", "sustainable", "earthy"] },
  { q: "adjustable dumbbells home gym", category: "fitness", tags: ["home-gym", "practical"] },
  { q: "linen shirt men women", category: "fashion", tags: ["breathable", "classic", "summer"] },
  { q: "vintage denim jacket", category: "fashion", tags: ["vintage", "casual", "streetwear"] },
  { q: "white leather sneakers", category: "footwear", tags: ["classic", "minimalist", "everyday"] },
  { q: "trail running shoes", category: "footwear", tags: ["outdoorsy", "durable", "sporty"] },
  { q: "cast iron dutch oven", category: "kitchen", tags: ["heirloom", "practical", "slow-cooking"] },
  { q: "pour over coffee maker", category: "kitchen", tags: ["ritual", "minimalist", "artisan"] },
  { q: "vitamin c face serum", category: "beauty", tags: ["skincare", "glow", "self-care"] },
  { q: "camping hammock lightweight", category: "outdoors", tags: ["outdoorsy", "adventure", "compact"] },
  { q: "ergonomic gaming chair", category: "gaming", tags: ["techy", "comfort", "battle-station"] },
  { q: "orthopedic dog bed", category: "pets", tags: ["cozy", "practical", "pet-parent"] },
  { q: "dot grid journal notebook", category: "stationery", tags: ["ritual", "minimalist", "creative"] },
  { q: "carry on travel backpack", category: "travel", tags: ["adventure", "practical", "organized"] },
];

const CATEGORY_EMOJI = {
  fashion: "🧥", footwear: "👟", tech: "🎧", home: "🛋", kitchen: "🍳",
  fitness: "🏋", beauty: "🧴", outdoors: "🏕", gaming: "🎮", pets: "🐕",
  stationery: "📓", travel: "🎒",
};

/** Deterministic small hash for ids/hues. */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Defensive per-item mapping — accepts the field spellings providers use. */
function mapItem(it, spec) {
  const title = it.title ?? it.name;
  const price = it.extracted_price
    ?? Number(String(it.price ?? "").replace(/[^0-9.]/g, "")) ;
  const seller = it.seller ?? it.source ?? it.merchant ?? it.store ?? "Google Shopping";
  const url = it.link ?? it.product_link ?? it.offers_link ?? it.url;
  const image = it.thumbnail ?? it.image ?? it.thumbnail_url;
  if (!title || !url || !image || !Number.isFinite(price) || price <= 0) return null;

  const bits = [];
  if (it.rating) bits.push(`${it.rating}★${it.reviews ? ` (${Number(it.reviews).toLocaleString("en-US")} reviews)` : ""}`);
  if (it.delivery) bits.push(String(it.delivery));

  return {
    id: `g-${it.product_id ?? hash(`${title}|${seller}`)}`,
    title: String(title).slice(0, 90),
    brand: "",
    platform: String(seller).slice(0, 40),
    category: spec.category,
    price: Math.round(price),
    tags: spec.tags,
    emoji: CATEGORY_EMOJI[spec.category] ?? "🛍",
    hue: hash(String(title)) % 360,
    blurb: bits.join(" · "),
    image: String(image),
    images: [...new Set([image, it.thumbnail_2, ...(Array.isArray(it.thumbnails) ? it.thumbnails : [])]
      .filter(Boolean).map(String))],
    url: String(url),
  };
}

async function fetchQuery(spec, key) {
  const params = new URLSearchParams({ engine: "google_shopping", q: spec.q, gl: "us", hl: "en", api_key: key });
  const res = await fetch(`https://www.searchapi.io/api/v1/search?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for "${spec.q}": ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const fixtureAt = process.argv.indexOf("--fixture");
const fixture = fixtureAt !== -1 ? JSON.parse(readFileSync(process.argv[fixtureAt + 1], "utf8")) : null;
const key = process.env.SEARCHAPI_KEY;
if (!fixture && !key) {
  console.error("SEARCHAPI_KEY is not set and no --fixture given.");
  process.exit(1);
}

const products = [];
const seen = new Set();
let loggedSample = false;

for (const spec of QUERIES) {
  let json;
  try {
    json = fixture ?? (await fetchQuery(spec, key));
  } catch (err) {
    console.error(`query failed: ${err.message}`);
    continue;
  }
  const items = json.shopping_results ?? json.results ?? json.shopping_ads ?? [];
  if (!loggedSample && items.length) {
    console.log("sample raw item:", JSON.stringify(items[0], null, 2));
    loggedSample = true;
  }
  let kept = 0;
  for (const it of items) {
    if (kept >= PER_QUERY) break;
    const p = mapItem(it, spec);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    products.push(p);
    kept++;
  }
  console.log(`"${spec.q}": ${items.length} results, kept ${kept}`);
  if (fixture) break; // a fixture is a single response — no point looping
  await new Promise((r) => setTimeout(r, 700)); // be polite to the API
}

if (products.length < (fixture ? 1 : MIN_TOTAL)) {
  console.error(`Only ${products.length} products mapped — refusing to overwrite the catalog.`);
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: products.length, products }, null, 1));
console.log(`catalog.json written: ${products.length} products across ${new Set(products.map((p) => p.category)).size} categories`);
