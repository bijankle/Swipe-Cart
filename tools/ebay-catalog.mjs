/**
 * Build catalog products from eBay's official Browse API (free, 5k calls/day).
 *
 * Flow: OAuth2 client-credentials token → item_summary/search per themed
 * query → getItem detail per kept listing (full photo gallery, description,
 * and localizedAspects — the real specs table) → merge into catalog.json.
 *
 * Env:
 *   EBAY_APP_ID / EBAY_CERT_ID   required — production keyset (repo secrets)
 *   DEBUG_ONE=true               1 query, 2 items, dump raw JSON, no write
 *   PER_QUERY                    listings to keep per query (default 8)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OUT = new URL("../catalog.json", import.meta.url).pathname;
const APP_ID = process.env.EBAY_APP_ID;
const CERT_ID = process.env.EBAY_CERT_ID;
const DEBUG_ONE = process.env.DEBUG_ONE === "true";
const PER_QUERY = Math.max(1, Number(process.env.PER_QUERY ?? 6));
const API = "https://api.ebay.com";

if (!APP_ID || !CERT_ID) {
  console.error("EBAY_APP_ID / EBAY_CERT_ID not set.");
  process.exit(1);
}

// 5 themes per category — variety is what makes endless noping worthwhile.
const QUERIES = [
  { q: "minimalist ceramic table lamp", category: "home", tags: ["minimalist", "modern", "warm-light"] },
  { q: "chunky knit throw blanket", category: "home", tags: ["cozy", "soft", "hygge"] },
  { q: "scented soy candle set", category: "home", tags: ["cozy", "ritual", "self-care"] },
  { q: "modern area rug", category: "home", tags: ["modern", "statement", "soft"] },
  { q: "boho wall art print set", category: "home", tags: ["boho", "creative", "statement"] },
  { q: "retro mechanical keyboard", category: "tech", tags: ["retro", "techy", "desk-setup"] },
  { q: "wireless noise cancelling headphones", category: "tech", tags: ["techy", "commute", "minimalist"] },
  { q: "smart watch fitness", category: "tech", tags: ["techy", "sporty", "everyday"] },
  { q: "portable bluetooth speaker", category: "tech", tags: ["techy", "outdoorsy", "compact"] },
  { q: "e-reader ereader", category: "tech", tags: ["techy", "cozy", "commute"] },
  { q: "cork yoga mat", category: "fitness", tags: ["wellness", "sustainable", "earthy"] },
  { q: "adjustable dumbbells", category: "fitness", tags: ["home-gym", "practical"] },
  { q: "kettlebell cast iron", category: "fitness", tags: ["home-gym", "durable"] },
  { q: "resistance bands set", category: "fitness", tags: ["home-gym", "compact", "practical"] },
  { q: "foam roller massage", category: "fitness", tags: ["wellness", "recovery", "self-care"] },
  { q: "linen shirt", category: "fashion", tags: ["breathable", "classic", "summer"] },
  { q: "vintage denim jacket", category: "fashion", tags: ["vintage", "casual", "streetwear"] },
  { q: "cashmere sweater", category: "fashion", tags: ["cozy", "classic", "luxury"] },
  { q: "polarized sunglasses", category: "fashion", tags: ["classic", "summer", "everyday"] },
  { q: "canvas tote bag", category: "fashion", tags: ["casual", "practical", "sustainable"] },
  { q: "white leather sneakers", category: "footwear", tags: ["classic", "minimalist", "everyday"] },
  { q: "trail running shoes", category: "footwear", tags: ["outdoorsy", "durable", "sporty"] },
  { q: "chelsea boots leather", category: "footwear", tags: ["classic", "sleek", "autumn"] },
  { q: "suede loafers", category: "footwear", tags: ["classic", "smart-casual"] },
  { q: "slide sandals comfort", category: "footwear", tags: ["summer", "casual", "everyday"] },
  { q: "cast iron dutch oven", category: "kitchen", tags: ["heirloom", "practical", "slow-cooking"] },
  { q: "pour over coffee maker", category: "kitchen", tags: ["ritual", "minimalist", "artisan"] },
  { q: "japanese chef knife", category: "kitchen", tags: ["artisan", "sharp", "heirloom"] },
  { q: "espresso machine home", category: "kitchen", tags: ["ritual", "techy", "entertaining"] },
  { q: "stoneware dinnerware set", category: "kitchen", tags: ["artisan", "entertaining", "earthy"] },
  { q: "vitamin c face serum", category: "beauty", tags: ["skincare", "glow", "self-care"] },
  { q: "jade roller gua sha set", category: "beauty", tags: ["skincare", "ritual", "self-care"] },
  { q: "hair styler hot brush", category: "beauty", tags: ["glow", "techy", "everyday"] },
  { q: "unisex perfume fragrance", category: "beauty", tags: ["luxury", "statement", "self-care"] },
  { q: "sheet mask skincare set", category: "beauty", tags: ["skincare", "self-care", "glow"] },
  { q: "camping hammock", category: "outdoors", tags: ["outdoorsy", "adventure", "compact"] },
  { q: "insulated water bottle", category: "outdoors", tags: ["outdoorsy", "practical", "everyday"] },
  { q: "hiking daypack", category: "outdoors", tags: ["outdoorsy", "adventure", "durable"] },
  { q: "camping lantern rechargeable", category: "outdoors", tags: ["outdoorsy", "techy", "compact"] },
  { q: "waterproof picnic blanket", category: "outdoors", tags: ["outdoorsy", "cozy", "summer"] },
  { q: "ergonomic gaming chair", category: "gaming", tags: ["techy", "comfort", "battle-station"] },
  { q: "wireless gaming mouse", category: "gaming", tags: ["techy", "battle-station", "sporty"] },
  { q: "gaming headset microphone", category: "gaming", tags: ["techy", "battle-station"] },
  { q: "retro game console handheld", category: "gaming", tags: ["retro", "techy", "cozy"] },
  { q: "controller charging dock", category: "gaming", tags: ["techy", "practical", "desk-setup"] },
  { q: "orthopedic dog bed", category: "pets", tags: ["cozy", "practical", "pet-parent"] },
  { q: "cat tree tower", category: "pets", tags: ["pet-parent", "statement", "practical"] },
  { q: "automatic pet feeder", category: "pets", tags: ["pet-parent", "techy", "practical"] },
  { q: "dog harness no pull", category: "pets", tags: ["pet-parent", "outdoorsy", "durable"] },
  { q: "interactive cat toy", category: "pets", tags: ["pet-parent", "playful"] },
  { q: "dot grid journal", category: "stationery", tags: ["ritual", "minimalist", "creative"] },
  { q: "fountain pen gift", category: "stationery", tags: ["heirloom", "ritual", "classic"] },
  { q: "washi tape set aesthetic", category: "stationery", tags: ["creative", "playful", "cozy"] },
  { q: "desk organizer wood", category: "stationery", tags: ["desk-setup", "minimalist", "practical"] },
  { q: "sticker pack aesthetic", category: "stationery", tags: ["creative", "playful"] },
  { q: "carry on travel backpack", category: "travel", tags: ["adventure", "practical", "organized"] },
  { q: "packing cubes set", category: "travel", tags: ["organized", "practical", "compact"] },
  { q: "memory foam travel pillow", category: "travel", tags: ["comfort", "commute", "compact"] },
  { q: "hanging toiletry bag", category: "travel", tags: ["organized", "practical"] },
  { q: "hard shell luggage carry on", category: "travel", tags: ["adventure", "sleek", "durable"] },
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

const stripHtml = (s) =>
  String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ").trim();

async function getToken() {
  const res = await fetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${APP_ID}:${CERT_ID}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(`token failed: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json.access_token;
}

async function browse(path, token) {
  const res = await fetch(`${API}/buy/browse/v1${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "Accept-Encoding": "gzip",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path.slice(0, 80)}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function mapItem(summary, detail, spec) {
  const title = stripHtml(detail.title ?? summary.title);
  const price = Number(detail.price?.value ?? summary.price?.value);
  const images = [...new Set(
    [detail.image?.imageUrl, ...(detail.additionalImages ?? []).map((i) => i?.imageUrl)]
      .filter(Boolean).map(String),
  )].slice(0, 8);
  if (!title || !images.length || !Number.isFinite(price) || price <= 0) return null;

  // Trimmed for payload size — with 400+ products, catalog.json bytes matter.
  const aspects = Array.isArray(detail.localizedAspects)
    ? detail.localizedAspects
        .map((a) => ({ name: String(a.name ?? "").slice(0, 60), value: String(a.value ?? "").slice(0, 160) }))
        .filter((a) => a.name && a.value).slice(0, 20)
    : [];
  const brand = aspects.find((a) => a.name.toLowerCase() === "brand")?.value ?? "";
  const desc = stripHtml(detail.shortDescription ?? detail.description ?? "").slice(0, 500);
  // Deliberately no seller-derived fields: keeps us squarely inside eBay's
  // "does not persist eBay (user) data" exemption — listing content only.
  const bits = [detail.condition].filter(Boolean);

  return {
    id: `e-${detail.itemId ?? summary.itemId}`,
    title: title.slice(0, 90),
    brand: brand.slice(0, 40),
    platform: "eBay",
    category: spec.category,
    price: Math.round(price),
    tags: spec.tags,
    emoji: CATEGORY_EMOJI[spec.category] ?? "🛍",
    hue: hash(title) % 360,
    blurb: bits.join(" · "),
    image: images[0],
    images,
    url: detail.itemWebUrl ?? summary.itemWebUrl,
    ...(desc ? { description: desc } : {}),
    ...(aspects.length ? { specs: aspects } : {}),
  };
}

const isInteractive = (p) =>
  (p.images?.length ?? 0) > 1 && Boolean(p.specs?.length || p.description || p.features?.length);

const token = await getToken();
console.log("token OK");

const results = [];
let dumped = false;
for (const spec of DEBUG_ONE ? QUERIES.slice(0, 1) : QUERIES) {
  let search;
  try {
    const params = new URLSearchParams({
      q: spec.q,
      limit: "30",
      filter: "buyingOptions:{FIXED_PRICE},price:[10..800],priceCurrency:USD,itemLocationCountry:US",
    });
    search = await browse(`/item_summary/search?${params}`, token);
  } catch (err) {
    console.error(`[${spec.q}] search failed: ${err.message}`);
    continue;
  }
  const summaries = search.itemSummaries ?? [];
  console.log(`[${spec.q}] ${summaries.length} listings`);

  const want = DEBUG_ONE ? 2 : PER_QUERY;
  let kept = 0;
  for (const s of summaries) {
    if (kept >= want) break;
    try {
      const detail = await browse(`/item/${encodeURIComponent(s.itemId)}`, token);
      if (!dumped) {
        const clone = { ...detail };
        delete clone.additionalImages;
        console.log("sample detail keys:", Object.keys(detail).join(", "));
        console.log("sample detail (trimmed):", JSON.stringify(clone, null, 1).slice(0, 3500));
        dumped = true;
      }
      const p = mapItem(s, detail, spec);
      if (!p || !isInteractive(p)) {
        if (DEBUG_ONE) console.log(`[${spec.q}] skipped (photos ${p?.images?.length ?? 0}, specs ${p?.specs?.length ?? 0})`);
        continue;
      }
      if (DEBUG_ONE) console.log(`[${spec.q}] mapped: "${p.title}" $${p.price} · ${p.images.length} photos · ${p.specs?.length ?? 0} specs · desc ${p.description ? "yes" : "no"}`);
      results.push(p);
      kept++;
    } catch (err) {
      console.error(`[${spec.q}] item failed: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  await new Promise((r) => setTimeout(r, 300));
}

if (DEBUG_ONE) {
  console.log(`DEBUG_ONE: ${results.length} mapped — not writing catalog.json`);
  process.exit(0);
}

console.log(`${results.length} interactive eBay products mapped`);
if (results.length < 10) {
  console.error("Too few results — refusing to rewrite the catalog.");
  process.exit(1);
}

let existing = [];
if (existsSync(OUT)) {
  try { existing = JSON.parse(readFileSync(OUT, "utf8")).products ?? []; } catch {}
}
// Every run REPLACES all eBay-sourced entries (ids `e-…`): eBay data is a
// self-expiring cache, never accumulated — per the account-deletion exemption.
const merged = [...existing.filter((p) => !p.id.startsWith("e-")), ...results];
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), count: merged.length, products: merged }, null, 1));
console.log(`catalog.json written: ${merged.length} products (${results.length} new/updated from eBay)`);
