/**
 * Live API endpoint (Cloudflare Worker proxying eBay).
 * Local dev talks to a mock/worker on :8787; production URL is filled in
 * after the worker's first deploy. Empty string disables the live tier —
 * the app then runs purely on the static catalog.
 */
export const API_BASE =
  typeof location !== "undefined" && location.hostname === "localhost"
    ? "http://localhost:8787"
    : "https://swipe-cart-api.bijank-2015.workers.dev";
