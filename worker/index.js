/**
 * Swipe Shop API proxy — a tiny Cloudflare Worker that holds the eBay keys
 * so the public web app can search and fetch item details live, driven by
 * the user's on-device taste model.
 *
 * Routes:
 *   GET /search?q=<text>&limit=<n>   → eBay item_summary/search (the "map" tier)
 *   GET /item?id=<itemId>            → eBay getItem (the "dig deeper" tier)
 *
 * Worker secrets: EBAY_APP_ID, EBAY_CERT_ID.
 * The app-level OAuth token is cached in isolate memory until expiry.
 */

const EBAY = "https://api.ebay.com";
const ALLOWED_ORIGINS = new Set([
  "https://bijankle.github.io",
  "http://localhost:4180", // local dev
]);

let cachedToken = null; // { token, exp }

async function getToken(env) {
  if (cachedToken && Date.now() < cachedToken.exp - 60_000) return cachedToken.token;
  const res = await fetch(`${EBAY}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${env.EBAY_APP_ID}:${env.EBAY_CERT_ID}`)}`,
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(`ebay token failed: ${res.status}`);
  cachedToken = { token: json.access_token, exp: Date.now() + (json.expires_in ?? 7200) * 1000 };
  return cachedToken.token;
}

async function ebay(path, env) {
  const token = await getToken(env);
  const res = await fetch(`${EBAY}/buy/browse/v1${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://bijankle.github.io",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: cors });

    const url = new URL(request.url);
    try {
      let upstream;
      if (url.pathname === "/search") {
        const q = (url.searchParams.get("q") ?? "").slice(0, 120);
        if (!q.trim()) return new Response('{"error":"q required"}', { status: 400, headers: cors });
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
        const params = new URLSearchParams({
          q,
          limit: String(limit),
          filter: "buyingOptions:{FIXED_PRICE},price:[8..900],priceCurrency:USD,itemLocationCountry:US",
        });
        upstream = await ebay(`/item_summary/search?${params}`, env);
      } else if (url.pathname === "/item") {
        const id = url.searchParams.get("id") ?? "";
        if (!/^v1\|[\w|]+$/.test(id)) return new Response('{"error":"bad id"}', { status: 400, headers: cors });
        upstream = await ebay(`/item/${encodeURIComponent(id)}`, env);
      } else {
        return new Response('{"error":"not found"}', { status: 404, headers: cors });
      }
      const out = new Response(upstream.body, upstream);
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
      // Let the browser (and Cloudflare edge) cache briefly to save API calls.
      out.headers.set("Cache-Control", url.pathname === "/item" ? "public, max-age=3600" : "public, max-age=600");
      return out;
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err.message ?? err) }), { status: 502, headers: cors });
    }
  },
};
