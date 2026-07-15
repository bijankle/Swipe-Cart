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

async function api(params, key) {
  const qs = new URLSearchParams({ ...params, gl: "us", hl: "en", api_key: key });
  const res = await fetch(`https://www.searchapi.io/api/v1/search?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/**
 * Enrich a product from a google_product detail response: full photo set,
 * description, feature highlights, spec rows, and — when an offer exposes a
 * non-Google link — the merchant's own product page. Defensive on names.
 */
function enrich(p, json) {
  const prod = json.product ?? json.product_results ?? json;

  const media = prod.images ?? prod.media ?? json.images ?? [];
  const imgs = (Array.isArray(media) ? media : [])
    .map((m) => (typeof m === "string" ? m : m?.link ?? m?.image ?? m?.url))
    .filter((u) => u && !String(u).startsWith("x-raw-image"));
  if (imgs.length) p.images = [...new Set(imgs.map(String))].slice(0, 8);

  if (prod.brand) p.brand = String(prod.brand).slice(0, 40);

  const desc = prod.description ?? json.description;
  if (desc) p.description = String(desc).slice(0, 700);

  const high = prod.highlights ?? prod.extensions ?? json.highlights;
  if (Array.isArray(high) && high.length) p.features = high.map(String).slice(0, 10);

  const specs = [];
  const push = (name, value) => {
    if (name && value != null && String(value).trim() && specs.length < 40)
      specs.push({ name: String(name).slice(0, 60), value: String(value).slice(0, 200) });
  };
  const specSrc = prod.specifications ?? prod.specs ?? json.specifications ?? json.specs_results ?? prod.details;
  if (Array.isArray(specSrc)) {
    for (const s of specSrc) {
      if (Array.isArray(s?.attributes)) for (const a of s.attributes) push(a.name ?? a.key, a.value);
      else push(s?.name ?? s?.key ?? s?.title, s?.value ?? s?.text);
    }
  } else if (specSrc && typeof specSrc === "object") {
    for (const [k, v] of Object.entries(specSrc)) push(k, typeof v === "object" ? JSON.stringify(v) : v);
  }
  if (specs.length) p.specs = specs;

  const offers = json.offers ?? json.sellers_results?.online_sellers ?? json.online_sellers ?? prod.offers ?? [];
  const offer = Array.isArray(offers) ? offers.find((o) => {
    const link = o?.link ?? o?.offer_link ?? o?.url;
    return link && !/google\./.test(String(link));
  }) : null;
  if (offer) {
    p.url = String(offer.link ?? offer.offer_link ?? offer.url);
    const name = offer.seller ?? offer.name ?? offer.merchant;
    if (name) p.platform = String(name).slice(0, 40);
  }
  return p;
}

const fixtureAt = process.argv.indexOf("--fixture");
const fixture = fixtureAt !== -1 ? JSON.parse(readFileSync(process.argv[fixtureAt + 1], "utf8")) : null;
const key = process.env.SEARCHAPI_KEY;
if (!fixture && !key) {
  console.error("SEARCHAPI_KEY is not set and no --fixture given.");
  process.exit(1);
}

const DEBUG_ONE = process.env.DEBUG_ONE === "true";
const DETAIL_BUDGET = Math.max(0, Number(process.env.DETAIL_BUDGET ?? 40));

const products = [];
const pids = new Map(); // product.id → product_token for detail lookups
const perQuery = new Map(); // query → its products, for round-robin enrichment
const seen = new Set();
let loggedSample = false;

for (const spec of DEBUG_ONE ? QUERIES.slice(0, 1) : QUERIES) {
  let json;
  try {
    json = fixture ?? (await api({ engine: "google_shopping", q: spec.q }, key));
  } catch (err) {
    console.error(`query failed: ${err.message}`);
    continue;
  }
  const items = json.shopping_results ?? json.results ?? json.shopping_ads ?? [];
  if (!loggedSample && items.length) {
    console.log("sample raw item:", JSON.stringify(items[0], null, 2).slice(0, 2500));
    loggedSample = true;
  }
  const mine = [];
  for (const it of items) {
    if (mine.length >= PER_QUERY) break;
    const p = mapItem(it, spec);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    // google_product requires the per-search product_token (not product_id),
    // and tokens are only valid shortly after the search that minted them.
    if (it.product_token) pids.set(p.id, String(it.product_token));
    mine.push(p);
    products.push(p);
  }
  perQuery.set(spec.q, mine);
  console.log(`"${spec.q}": ${items.length} results, kept ${mine.length}`);
  if (fixture) break; // a fixture is a single response — no point looping
  await new Promise((r) => setTimeout(r, 700)); // be polite to the API
}

// ---- Detail enrichment: specs, full photo sets, merchant links. ----------
// Each detail lookup costs one API credit, so a round-robin across queries
// spends DETAIL_BUDGET evenly — every category gets some enriched cards.
if (!fixture && DETAIL_BUDGET > 0) {
  const queues = [...perQuery.values()].map((list) => list.filter((p) => pids.has(p.id)));
  let spent = 0, enriched = 0, dumped = false;
  for (let round = 0; queues.some((q) => q.length) && spent < (DEBUG_ONE ? 1 : DETAIL_BUDGET); round++) {
    for (const queue of queues) {
      if (spent >= (DEBUG_ONE ? 1 : DETAIL_BUDGET)) break;
      const p = queue.shift();
      if (!p) continue;
      spent++;
      try {
        const json = await api({ engine: "google_product", product_token: pids.get(p.id) }, key);
        if (!dumped) {
          // Trim the noisy fields so the useful schema (specs, description,
          // offers, reviews) survives the log-size cap.
          const clone = { ...json };
          delete clone.search_metadata;
          delete clone.search_parameters;
          if (clone.product) {
            clone.product = { ...clone.product, images: `[${json.product.images?.length ?? 0} urls]` };
            delete clone.product.videos;
          }
          console.log("detail top-level keys:", Object.keys(json).join(", "));
          if (json.product) console.log("product keys:", Object.keys(json.product).join(", "));
          console.log("sample raw product detail (trimmed):", JSON.stringify(clone, null, 1).slice(0, 6000));
          dumped = true;
        }
        enrich(p, json);
        enriched++;
      } catch (err) {
        console.error(`detail failed for "${p.title}": ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  console.log(`enriched ${enriched} products with details (${spent} detail calls)`);
}

if (DEBUG_ONE) {
  console.log("DEBUG_ONE run — not writing catalog.json");
  process.exit(0);
}

if (products.length < (fixture ? 1 : MIN_TOTAL)) {
  console.error(`Only ${products.length} products mapped — refusing to overwrite the catalog.`);
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: products.length, products }, null, 1));
console.log(`catalog.json written: ${products.length} products across ${new Set(products.map((p) => p.category)).size} categories`);
