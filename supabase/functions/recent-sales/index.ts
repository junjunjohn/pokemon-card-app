// Supabase Edge Function: recent-sales
//
// Returns the last N *individual* completed sales for a Pokémon card from
// TCGplayer. This has to run server-side (not in the browser) for two reasons:
//   1. TCGplayer's sales endpoint is CORS-locked and 403s without a browser-like
//      Origin/Referer/User-Agent — headers a browser isn't allowed to forge.
//   2. It keeps us off the client's rate limit and lets us cache centrally.
//
// The client can't send us a TCGplayer product id (its card data doesn't carry
// one), so we resolve it here. The reliable path is pokemontcg.io's
// `tcgplayer.url`, a redirect that lands on the real product page whose URL
// contains the id. Cards whose mapping pokemontcg.io hasn't filled in yet won't
// resolve — we return match: "none" and the client falls back to the average.
//
// Deploy:  supabase functions deploy recent-sales
// Call:    POST {SUPABASE_URL}/functions/v1/recent-sales
//          Authorization: Bearer <anon key>
//          body: { "tcgplayerUrl": "https://prices.pokemontcg.io/tcgplayer/<id>", "limit": 5 }

const TCG_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/plain, */*",
  "Origin": "https://www.tcgplayer.com",
  "Referer": "https://www.tcgplayer.com/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

const CORS = {
  "Access-Control-Allow-Origin": "*", // public price data, no cookies/credentials
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// Follow pokemontcg.io's redirect to the real TCGplayer product page and pull
// the numeric product id out of its URL. Returns null if the URL never leaves
// pokemontcg.io (i.e. no mapping exists yet).
async function resolveProductId(tcgplayerUrl: string): Promise<number | null> {
  try {
    const resp = await fetch(tcgplayerUrl, {
      redirect: "follow",
      headers: { "User-Agent": TCG_HEADERS["User-Agent"] },
    });
    const m = resp.url.match(/\/product\/(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function fetchLatestSales(productId: number, limit: number) {
  const resp = await fetch(
    `https://mpapi.tcgplayer.com/v2/product/${productId}/latestsales`,
    {
      method: "POST",
      headers: TCG_HEADERS,
      body: JSON.stringify({
        conditions: [],
        languages: [],
        variants: [],
        listingType: "All",
        offset: 0,
        limit,
      }),
    },
  );
  if (!resp.ok) throw new Error(`TCGplayer sales endpoint returned ${resp.status}`);
  const body = await resp.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  return rows.slice(0, limit).map((s: Record<string, unknown>) => ({
    price: s.purchasePrice ?? null, // the card price; shipping is separate
    shipping: s.shippingPrice ?? null,
    condition: s.condition ?? null,
    variant: s.variant ?? null,
    language: s.language ?? null,
    quantity: s.quantity ?? 1,
    date: s.orderDate ?? null,
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let payload: { tcgplayerUrl?: string; productId?: number; limit?: number };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const limit = Math.min(Math.max(Number(payload.limit) || 5, 1), 25);

  let productId = Number(payload.productId) || null;
  if (!productId && payload.tcgplayerUrl) {
    productId = await resolveProductId(payload.tcgplayerUrl);
  }

  if (!productId) {
    // No TCGplayer mapping for this card — the client shows the average instead.
    return json({ match: "none", productId: null, sales: [] });
  }

  try {
    const sales = await fetchLatestSales(productId, limit);
    return json({ match: "exact", productId, currency: "USD", sales });
  } catch (err) {
    return json(
      { match: "error", productId, sales: [], error: String((err as Error).message) },
      502,
    );
  }
});
