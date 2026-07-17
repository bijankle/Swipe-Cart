/**
 * Live feed tier — talks to the API worker (see worker/index.js).
 *
 * Tier 0 (map): cheap search summaries — thousands of candidate items as
 * text (title, price, one thumbnail). Nothing deep is fetched here.
 * Tier 2 (dig deeper): full item details (gallery, specs, description)
 * fetched just-in-time, only for items the taste model ranks highly.
 */

import { API_BASE } from "./config.js";

const CATEGORY_EMOJI = {
  fashion: "🧥", footwear: "👟", tech: "🎧", home: "🛋", kitchen: "🍳",
  fitness: "🏋", beauty: "🧴", outdoors: "🏕", gaming: "🎮", pets: "🐕",
  stationery: "📓", travel: "🎒",
};

/** The broad map sweep — the starting universe the taste model ranks. */
export const MAP_QUERIES = [
  { q: "ceramic table lamp", category: "home", tags: ["minimalist", "warm-light"] },
  { q: "throw blanket", category: "home", tags: ["cozy", "soft"] },
  { q: "scented candle", category: "home", tags: ["cozy", "ritual"] },
  { q: "area rug", category: "home", tags: ["modern", "statement"] },
  { q: "wall art print", category: "home", tags: ["creative", "statement"] },
  { q: "mechanical keyboard", category: "tech", tags: ["techy", "desk-setup"] },
  { q: "noise cancelling headphones", category: "tech", tags: ["techy", "commute"] },
  { q: "smart watch", category: "tech", tags: ["techy", "sporty"] },
  { q: "bluetooth speaker", category: "tech", tags: ["techy", "compact"] },
  { q: "e-reader", category: "tech", tags: ["techy", "cozy"] },
  { q: "yoga mat", category: "fitness", tags: ["wellness", "earthy"] },
  { q: "adjustable dumbbells", category: "fitness", tags: ["home-gym"] },
  { q: "kettlebell", category: "fitness", tags: ["home-gym", "durable"] },
  { q: "resistance bands", category: "fitness", tags: ["home-gym", "compact"] },
  { q: "foam roller", category: "fitness", tags: ["wellness", "recovery"] },
  { q: "linen shirt", category: "fashion", tags: ["breathable", "classic"] },
  { q: "denim jacket", category: "fashion", tags: ["vintage", "casual"] },
  { q: "cashmere sweater", category: "fashion", tags: ["cozy", "luxury"] },
  { q: "polarized sunglasses", category: "fashion", tags: ["classic", "summer"] },
  { q: "tote bag", category: "fashion", tags: ["casual", "practical"] },
  { q: "leather sneakers", category: "footwear", tags: ["classic", "everyday"] },
  { q: "trail running shoes", category: "footwear", tags: ["outdoorsy", "sporty"] },
  { q: "chelsea boots", category: "footwear", tags: ["classic", "sleek"] },
  { q: "suede loafers", category: "footwear", tags: ["classic", "smart-casual"] },
  { q: "slide sandals", category: "footwear", tags: ["summer", "casual"] },
  { q: "dutch oven", category: "kitchen", tags: ["heirloom", "slow-cooking"] },
  { q: "pour over coffee", category: "kitchen", tags: ["ritual", "artisan"] },
  { q: "chef knife", category: "kitchen", tags: ["artisan", "sharp"] },
  { q: "espresso machine", category: "kitchen", tags: ["ritual", "techy"] },
  { q: "dinnerware set", category: "kitchen", tags: ["artisan", "entertaining"] },
  { q: "face serum", category: "beauty", tags: ["skincare", "glow"] },
  { q: "gua sha set", category: "beauty", tags: ["skincare", "ritual"] },
  { q: "hair styler", category: "beauty", tags: ["glow", "techy"] },
  { q: "perfume", category: "beauty", tags: ["luxury", "statement"] },
  { q: "sheet mask set", category: "beauty", tags: ["skincare", "self-care"] },
  { q: "camping hammock", category: "outdoors", tags: ["outdoorsy", "compact"] },
  { q: "insulated water bottle", category: "outdoors", tags: ["outdoorsy", "everyday"] },
  { q: "hiking daypack", category: "outdoors", tags: ["outdoorsy", "adventure"] },
  { q: "camping lantern", category: "outdoors", tags: ["outdoorsy", "techy"] },
  { q: "picnic blanket", category: "outdoors", tags: ["outdoorsy", "summer"] },
  { q: "gaming chair", category: "gaming", tags: ["techy", "comfort"] },
  { q: "gaming mouse", category: "gaming", tags: ["techy", "battle-station"] },
  { q: "gaming headset", category: "gaming", tags: ["techy", "battle-station"] },
  { q: "retro game console", category: "gaming", tags: ["retro", "cozy"] },
  { q: "controller dock", category: "gaming", tags: ["techy", "desk-setup"] },
  { q: "dog bed", category: "pets", tags: ["cozy", "pet-parent"] },
  { q: "cat tree", category: "pets", tags: ["pet-parent", "statement"] },
  { q: "automatic pet feeder", category: "pets", tags: ["pet-parent", "techy"] },
  { q: "dog harness", category: "pets", tags: ["pet-parent", "outdoorsy"] },
  { q: "cat toy", category: "pets", tags: ["pet-parent", "playful"] },
  { q: "dot grid journal", category: "stationery", tags: ["ritual", "creative"] },
  { q: "fountain pen", category: "stationery", tags: ["heirloom", "classic"] },
  { q: "washi tape", category: "stationery", tags: ["creative", "playful"] },
  { q: "desk organizer", category: "stationery", tags: ["desk-setup", "minimalist"] },
  { q: "sticker pack", category: "stationery", tags: ["creative", "playful"] },
  { q: "travel backpack", category: "travel", tags: ["adventure", "organized"] },
  { q: "packing cubes", category: "travel", tags: ["organized", "compact"] },
  { q: "travel pillow", category: "travel", tags: ["comfort", "commute"] },
  { q: "toiletry bag", category: "travel", tags: ["organized", "practical"] },
  { q: "carry on luggage", category: "travel", tags: ["adventure", "sleek"] },
];

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const stripHtml = (s) =>
  String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ").trim();

export const liveEnabled = () => Boolean(API_BASE);

/** Rough eBay category-name → app category mapping, for free-text searches. */
function categoryFromEbay(categories) {
  const names = (categories ?? []).map((c) => String(c?.categoryName ?? "").toLowerCase()).join(" ");
  if (/shoe|sneaker|boot|sandal|heel|loafer/.test(names)) return "footwear";
  if (/clothing|shirt|dress|jacket|sweater|jean|coat|apparel|accessor/.test(names)) return "fashion";
  if (/kitchen|dining|cookware|bakeware|appliance/.test(names)) return "kitchen";
  if (/pet|dog|cat supplies/.test(names)) return "pets";
  if (/camping|hiking|outdoor|sporting goods|cycling|fishing/.test(names)) return "outdoors";
  if (/fitness|gym|exercise|yoga/.test(names)) return "fitness";
  if (/video game|console|gaming/.test(names)) return "gaming";
  if (/health|beauty|fragrance|skin|makeup|hair/.test(names)) return "beauty";
  if (/luggage|travel|suitcase|backpack/.test(names)) return "travel";
  if (/office|stationery|paper|pen|craft/.test(names)) return "stationery";
  if (/computer|electronic|audio|headphone|camera|phone|tablet/.test(names)) return "tech";
  return "home";
}

/** Map-tier: one search → up to `limit` lite candidates (text + thumbnail). */
export async function searchSummaries(spec, limit = 50) {
  const params = new URLSearchParams({ q: spec.q, limit: String(limit) });
  const res = await fetch(`${API_BASE}/search?${params}`);
  if (!res.ok) throw new Error(`search ${res.status}`);
  const json = await res.json();
  return (json.itemSummaries ?? [])
    .map((s) => {
      const title = stripHtml(s.title);
      const price = Number(s.price?.value);
      const image = s.image?.imageUrl ?? s.thumbnailImages?.[0]?.imageUrl;
      if (!title || !image || !Number.isFinite(price) || price <= 0) return null;
      const category = spec.category === "auto" ? categoryFromEbay(s.categories) : spec.category;
      return {
        lite: true, // needs a detail upgrade before it can be dealt
        ebayId: s.itemId,
        id: `e-${s.itemId}`,
        title: title.slice(0, 90),
        brand: "",
        platform: "eBay",
        category,
        price: Math.round(price),
        tags: spec.tags,
        emoji: CATEGORY_EMOJI[category] ?? "🛍",
        hue: hash(title) % 360,
        blurb: "",
        image,
        images: [image],
        url: s.itemWebUrl,
      };
    })
    .filter(Boolean);
}

/** Dig-deeper tier: upgrade one lite item to a full interactive product. */
export async function fetchDetail(lite) {
  const res = await fetch(`${API_BASE}/item?id=${encodeURIComponent(lite.ebayId)}`);
  if (!res.ok) throw new Error(`item ${res.status}`);
  const d = await res.json();
  const images = [...new Set(
    [d.image?.imageUrl, ...(d.additionalImages ?? []).map((i) => i?.imageUrl)].filter(Boolean).map(String),
  )].slice(0, 8);
  const specs = Array.isArray(d.localizedAspects)
    ? d.localizedAspects
        .map((a) => ({ name: String(a.name ?? "").slice(0, 60), value: String(a.value ?? "").slice(0, 160) }))
        .filter((a) => a.name && a.value).slice(0, 20)
    : [];
  const desc = stripHtml(d.shortDescription ?? "").slice(0, 500);
  const brand = specs.find((a) => a.name.toLowerCase() === "brand")?.value ?? "";
  return {
    ...lite,
    lite: false,
    brand: brand.slice(0, 40),
    blurb: d.condition ?? "",
    image: images[0] ?? lite.image,
    images: images.length ? images : lite.images,
    url: d.itemWebUrl ?? lite.url,
    ...(desc ? { description: desc } : {}),
    ...(specs.length ? { specs } : {}),
  };
}

/**
 * Turn the user's current taste into fresh search queries — this is what
 * makes the pool "all of eBay", steered by swipes instead of my presets.
 */
export function steeringQueries(summary, count = 2) {
  const traits = summary.traits ?? {};
  const words = [
    ...(traits.word ?? []).map((t) => t.value),
    ...(traits.tag ?? []).map((t) => t.value),
    ...(traits.brand ?? []).map((t) => t.value),
  ].slice(0, 8);
  const cat = (traits.cat ?? [])[0]?.value ?? "home";
  const queries = [];
  for (let i = 0; i + 1 < words.length && queries.length < count; i += 2) {
    queries.push({
      q: `${words[i]} ${words[i + 1]}`.slice(0, 60),
      category: cat,
      tags: [words[i], words[i + 1]].filter((w) => w.length < 20),
    });
  }
  return queries;
}
