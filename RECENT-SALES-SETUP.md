# Recent Sales (last 5 sold) — setup

The card detail modal shows a **"Last 5 sold"** list of real, individual TCGplayer
sales. The browser can't fetch these directly (TCGplayer's endpoint is CORS-locked
and 403s without a browser-like `Origin`/`Referer`/`User-Agent`), so a small
**Supabase Edge Function** (`supabase/functions/recent-sales`) fetches them
server-side and hands the last N back to the client.

## How it works

1. The client (`loadRecentSales` in `app.js`) POSTs the card's pokemontcg.io
   `tcgplayer.url` to the function.
2. The function follows that redirect to the real TCGplayer product page and
   pulls the numeric `productId` out of the final URL.
3. It calls TCGplayer's `latestsales` endpoint with browser headers and returns
   the normalized last N sales (price, condition, variant, qty, date).
4. The client renders them; if there's no TCGplayer mapping (`match: "none"`) or
   the call fails, the live list is dropped and the Cardmarket **average sold**
   block below it stands in.

Only cards carrying a `tcgplayer.url` resolve — the live **Top Picks** cards do
(they come straight from the Pokémon TCG API). Static portfolio-search cards
currently don't include the URL, so they show the average only.

## Deploy

You need the [Supabase CLI](https://supabase.com/docs/guides/cli) and to be
logged in / linked to this project once:

```bash
supabase login
supabase link --project-ref fdoasinihkhazzqqynrj
```

Then deploy the function:

```bash
supabase functions deploy recent-sales --no-verify-jwt
```

The function needs **no secrets** — it only calls public TCGplayer endpoints.

`--no-verify-jwt` is required: the page calls this function from the browser,
which first sends a CORS **preflight** (`OPTIONS`) request *without* an
Authorization header. With JWT verification on, Supabase rejects that preflight
and the browser blocks the real call (you'll see a CORS error in the console).
Turning it off lets the preflight through; the data is public price info, so
there's nothing to protect. `supabase/config.toml` also pins
`verify_jwt = false` for this function, so a plain `supabase functions deploy
recent-sales` will pick it up too.

## Test it

```bash
curl -s -X POST \
  "https://fdoasinihkhazzqqynrj.supabase.co/functions/v1/recent-sales" \
  -H "Authorization: Bearer <anon key>" \
  -H "Content-Type: application/json" \
  -d '{"tcgplayerUrl":"https://prices.pokemontcg.io/tcgplayer/me2-130","limit":5}'
```

Expect `{"match":"exact","productId":662185,"currency":"USD","sales":[...]}`.

## Caveats

- TCGplayer's `latestsales` endpoint is **unofficial** — it powers their own
  product pages but isn't a documented/supported API, so it can change or start
  rejecting requests without notice. The client fails soft to the average if so.
- No caching yet: each card view calls TCGplayer once. If views get heavy,
  add a small `productId -> sales` cache table (TTL a few hours) to be polite.
- Prices are USD and exclude shipping (shipping is returned separately if you
  want to show it).
