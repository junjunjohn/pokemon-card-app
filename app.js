const STORAGE_KEY = "pkmn_api_key";
const CARDS_CACHE_KEY = "pkmn_cards_cache";
const TOP_N_PER_CATEGORY = 10;
const BASKET_SIZE = 20; // how many popular Pokémon we scan — for status text only

// createClient() throws synchronously on an invalid URL — if config.js still has
// its placeholder values, we must not let that crash this whole script (every
// other feature's event listeners are registered further down this same file).
let sb = null;
let supabaseConfigured = false;
try {
  if (
    !SUPABASE_URL || !SUPABASE_ANON_KEY ||
    SUPABASE_URL.includes("YOUR_SUPABASE") || SUPABASE_ANON_KEY.includes("YOUR_SUPABASE")
  ) {
    throw new Error("Supabase is not configured yet.");
  }
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  supabaseConfigured = true;
} catch {
  supabaseConfigured = false;
}

const els = {
  refreshBtn: document.getElementById("refreshBtn"),
  currencySelect: document.getElementById("currencySelect"),
  sortSelect: document.getElementById("sortSelect"),
  filterPills: document.getElementById("filterPills"),
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsModal: document.getElementById("settingsModal"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  closeSettingsBtn: document.getElementById("closeSettingsBtn"),
  cardModal: document.getElementById("cardModal"),
  cardModalContent: document.getElementById("cardModalContent"),
  authScreen: document.getElementById("authScreen"),
  appRoot: document.getElementById("app"),
  loginForm: document.getElementById("loginForm"),
  loginUsername: document.getElementById("loginUsername"),
  loginPassword: document.getElementById("loginPassword"),
  loginError: document.getElementById("loginError"),
  signupForm: document.getElementById("signupForm"),
  signupUsername: document.getElementById("signupUsername"),
  signupPassword: document.getElementById("signupPassword"),
  signupError: document.getElementById("signupError"),
  showSignup: document.getElementById("showSignup"),
  showLogin: document.getElementById("showLogin"),
  logoutBtn: document.getElementById("logoutBtn"),
  currentUser: document.getElementById("currentUser"),
  tabNav: document.getElementById("tabNav"),
  topPicksTab: document.getElementById("topPicksTab"),
  portfolioTab: document.getElementById("portfolioTab"),
  cardSearchInput: document.getElementById("cardSearchInput"),
  cardSearchBtn: document.getElementById("cardSearchBtn"),
  searchStatus: document.getElementById("searchStatus"),
  searchResultsModal: document.getElementById("searchResultsModal"),
  searchResultsGrid: document.getElementById("searchResultsGrid"),
  closeSearchResultsBtn: document.getElementById("closeSearchResultsBtn"),
  portfolioStatus: document.getElementById("portfolioStatus"),
  portfolioResults: document.getElementById("portfolioResults"),
};

let currentCards = []; // enriched with .signal
let activeFilter = "ALL"; // "ALL" | "BUY" | "HOLD" | "SELL"
let selectedCurrency = "USD";
let fxRates = null; // { EUR, JPY, PHP } — units per 1 USD

// ---------- Currency conversion ----------
// Live daily rates from the European Central Bank via frankfurter.dev (free, no key).
// Card prices come in from the sources as USD (TCGplayer) or EUR (Cardmarket); we
// convert everything through USD as a common base.

const CURRENCY_SYMBOLS = { USD: "$", PHP: "₱", JPY: "¥" };

async function loadFxRates() {
  try {
    const res = await fetch("https://api.frankfurter.dev/v1/latest?from=USD&to=PHP,JPY,EUR");
    if (!res.ok) return;
    const data = await res.json();
    fxRates = data.rates;
    els.currencySelect.disabled = false;
    els.currencySelect.title = "";
  } catch {
    // Leave the dropdown disabled — prices just stay in their source currency.
  }
}

function convertPrice(amount, sourceCurrency) {
  if (amount == null || Number.isNaN(amount)) return null;
  if (sourceCurrency === selectedCurrency) return amount;
  if (!fxRates) return amount;

  const usdAmount = sourceCurrency === "USD" ? amount : amount / fxRates[sourceCurrency];
  if (selectedCurrency === "USD") return usdAmount;
  return usdAmount * fxRates[selectedCurrency];
}

// ---------- Data fetching ----------

// We're a static site now (no backend), so this calls the Pokémon TCG API
// directly from the browser and caches the result in localStorage for 30
// minutes — replicating the server-side cache serve.js used to keep, just
// per-visitor instead of shared. The Pokémon TCG API works unauthenticated
// at a low rate limit; the optional key from Settings raises that limit.
const POKEMON_API_BASE = "https://api.pokemontcg.io/v2/cards";
const POPULAR_POKEMON = [
  "charizard", "pikachu", "mewtwo", "mew", "umbreon", "sylveon",
  "rayquaza", "gengar", "lugia", "gyarados", "snorlax", "dragonite",
  "garchomp", "giratina", "arceus", "greninja", "blastoise", "venusaur",
  "eevee", "zacian",
];
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
// The upstream API can take 20+ seconds even on a successful response under
// load — a short timeout here converts "slow but would've worked" into a
// hard failure. Give it real room before giving up.
const REQUEST_TIMEOUT_MS = 25000;

function readCardsCache() {
  try {
    const raw = localStorage.getItem(CARDS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.fetchedAt || Date.now() - parsed.fetchedAt >= CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCardsCache(cards, fetchedAt) {
  try {
    localStorage.setItem(CARDS_CACHE_KEY, JSON.stringify({ cards, fetchedAt }));
  } catch {
    // localStorage full or unavailable — non-fatal, we just won't cache this time.
  }
}

// Per-card cache for portfolio price lookups (each saved card needs its own
// live-price fetch, separate from the top-20 popular-card scan above).
function readCardCache(cardId) {
  try {
    const raw = localStorage.getItem(`pkmn_card_${cardId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.fetchedAt || Date.now() - parsed.fetchedAt >= CACHE_TTL_MS) return null;
    return parsed.card;
  } catch {
    return null;
  }
}

function writeCardCache(cardId, card) {
  try {
    localStorage.setItem(`pkmn_card_${cardId}`, JSON.stringify({ card, fetchedAt: Date.now() }));
  } catch {
    // non-fatal
  }
}

// The free/unauthenticated Pokémon TCG API tier is known to be flaky and
// occasionally returns 500s under load — worse now that every visitor's
// first (uncached) load hits it directly with no shared server-side cache
// behind it (the original serve.js only retried once, backed by a shared
// cache absorbing most of the flakiness — we retry more here since a static
// site has no such cushion).
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000; // backs off: 1s, then 2s between attempts

async function fetchCardsOnce(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`Pokémon TCG API error (${res.status}).`);
    return await res.json().catch(() => ({}));
  } catch (err) {
    throw err.name === "AbortError"
      ? new Error("The Pokémon TCG API took too long to respond.")
      : err;
  } finally {
    clearTimeout(timer);
  }
}

function apiHeaders() {
  const key = localStorage.getItem(STORAGE_KEY);
  return key ? { "X-Api-Key": key } : {};
}

async function fetchPokemonApi(url, onRetry) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      return await fetchCardsOnce(url, apiHeaders());
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_ATTEMPTS) {
        onRetry?.(attempt, RETRY_ATTEMPTS);
        await new Promise((r) => setTimeout(r, RETRY_BASE_DELAY_MS * attempt));
      }
    }
  }
  throw lastError.message.includes("Pokémon TCG API")
    ? lastError
    : new Error("Couldn't reach the Pokémon TCG API. Check your connection.");
}

// 250 is the Pokémon TCG API's max page size — using it means one request
// covers virtually every search (even a name as common as "pikachu" has
// nowhere near 250 cards across all sets). If a search somehow exceeds that,
// totalCount lets the caller know results were truncated instead of silently
// hiding the rest.
async function searchCards(query, onRetry) {
  const url = `${POKEMON_API_BASE}?q=${encodeURIComponent(`name:"${query}*"`)}&pageSize=250`;
  const body = await fetchPokemonApi(url, onRetry);
  return { cards: body.data || [], totalCount: body.totalCount ?? body.data?.length ?? 0 };
}

async function fetchCardById(cardId, onRetry) {
  const url = `${POKEMON_API_BASE}/${encodeURIComponent(cardId)}`;
  const body = await fetchPokemonApi(url, onRetry);
  return body.data || null;
}

// Shared across every visitor (unlike the per-browser localStorage cache
// above) — read-only for the client, refreshed by whoever's browser
// happens to do a successful live fetch. Best-effort: any failure here
// just means we fall back to the live API, same as before this existed.
async function readSharedCache() {
  try {
    const { data, error } = await sb
      .from("cached_top_picks")
      .select("cards, fetched_at")
      .eq("id", 1)
      .maybeSingle();
    if (error || !data) return null;
    const fetchedAt = new Date(data.fetched_at).getTime();
    if (Date.now() - fetchedAt >= CACHE_TTL_MS) return null;
    return { cards: data.cards, fetchedAt };
  } catch {
    return null;
  }
}

async function writeSharedCache(cards) {
  try {
    await sb.rpc("refresh_top_picks_cache", { p_cards: cards });
  } catch {
    // non-fatal — just means the next visitor falls back to the live API too
  }
}

async function fetchTopPool(onRetry) {
  const cached = readCardsCache();
  if (cached) {
    return { cards: cached.cards, fetchedAt: cached.fetchedAt, stale: false };
  }

  if (supabaseConfigured) {
    const shared = await readSharedCache();
    if (shared) {
      writeCardsCache(shared.cards, shared.fetchedAt); // warm the local cache too
      return { cards: shared.cards, fetchedAt: shared.fetchedAt, stale: false };
    }
  }

  const query = "(" + POPULAR_POKEMON.map((n) => `name:"${n}*"`).join(" OR ") + ")";
  const url = `${POKEMON_API_BASE}?q=${encodeURIComponent(query)}&pageSize=100&orderBy=-set.releaseDate`;
  const body = await fetchPokemonApi(url, onRetry);

  const seen = new Set();
  const cards = (body.data || []).filter((card) => {
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });

  const fetchedAt = Date.now();
  writeCardsCache(cards, fetchedAt);
  if (supabaseConfigured) writeSharedCache(cards);
  return { cards, fetchedAt, stale: false };
}

// ---------- Pricing helpers ----------

const VARIANT_PRIORITY = ["holofoil", "reverseHolofoil", "normal", "1stEditionHolofoil", "1stEditionNormal"];

function getTcgVariant(card) {
  const prices = card.tcgplayer?.prices;
  if (!prices) return null;
  for (const key of VARIANT_PRIORITY) {
    if (prices[key]) return { variant: key, ...prices[key] };
  }
  const firstKey = Object.keys(prices)[0];
  return firstKey ? { variant: firstKey, ...prices[firstKey] } : null;
}

function getPriceBand(card) {
  // Note: TCGplayer's "high" is often a single outlier listing (e.g. a $2,600 ask on a
  // $300 card), so it's unusable as an upper bound for "is this cheap or expensive".
  // We anchor the expensive end on "mid" (typical active-listing price) instead.
  const tcg = getTcgVariant(card);
  if (tcg && tcg.low != null && tcg.market != null) {
    const mid = tcg.mid != null && tcg.mid > tcg.low ? tcg.mid : tcg.market * 1.15;
    return { low: tcg.low, mid, high: tcg.high, market: tcg.market, currency: "USD", source: "TCGplayer" };
  }
  const cm = card.cardmarket?.prices;
  if (cm && cm.lowPrice != null) {
    const market = cm.trendPrice ?? cm.averageSellPrice ?? cm.lowPrice;
    const mid = Math.max(cm.avg7 ?? 0, cm.averageSellPrice ?? 0, market, cm.lowPrice * 1.05);
    return { low: cm.lowPrice, mid, high: mid, market, currency: "EUR", source: "Cardmarket" };
  }
  return null;
}

function getMomentumPct(card) {
  const cm = card.cardmarket?.prices;
  if (!cm) return null;
  if (cm.avg7 != null && cm.avg30 != null && cm.avg30 > 0) {
    return ((cm.avg7 - cm.avg30) / cm.avg30) * 100;
  }
  if (cm.avg1 != null && cm.avg30 != null && cm.avg30 > 0) {
    return ((cm.avg1 - cm.avg30) / cm.avg30) * 100;
  }
  return null;
}

function fmt(n, sourceCurrency) {
  if (n == null || Number.isNaN(n)) return "—";
  const converted = convertPrice(n, sourceCurrency);
  const displayCurrency = fxRates ? selectedCurrency : sourceCurrency;
  const symbol = CURRENCY_SYMBOLS[displayCurrency] || (displayCurrency === "EUR" ? "€" : "$");
  const decimals = displayCurrency === "JPY" ? 0 : 2;
  return `${symbol}${converted.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

// ---------- Heuristic AI signal engine ----------
// Transparent rules-based score, not a black box: combines
// (1) where the current price sits within its own low-high band ("value"), and
// (2) recent short-term vs 30-day price momentum from Cardmarket history.

function computeSignal(card) {
  const band = getPriceBand(card);
  const momentum = getMomentumPct(card);
  const reasons = [];

  if (!band) {
    return { label: "HOLD", score: 0, reasons: ["Not enough market data to form a signal."], band, momentum };
  }

  const denom = Math.max(band.mid - band.low, 0.01);
  const position = (band.market - band.low) / denom; // 0 = at the low price, 1 = at/above typical mid price
  const clampedPosition = Math.max(0, Math.min(1, position));
  let valueScore = (0.5 - clampedPosition) * 100; // +50 cheap .. -50 expensive

  reasons.push(
    clampedPosition < 0.35
      ? `Market price is close to the low price for this card (${Math.round(clampedPosition * 100)}% of the way to typical mid price) — relatively cheap.`
      : clampedPosition > 0.65
      ? `Market price is close to or above the typical mid price for this card (${Math.round(clampedPosition * 100)}%+) — relatively expensive.`
      : `Market price sits roughly between the low and typical mid price (${Math.round(clampedPosition * 100)}%).`
  );

  let score = valueScore;

  if (momentum != null) {
    const clampedMomentum = Math.max(-25, Math.min(25, momentum));
    score += clampedMomentum * 0.6;
    reasons.push(
      momentum > 3
        ? `Short-term average is trending up (${momentum.toFixed(1)}% vs 30-day average).`
        : momentum < -3
        ? `Short-term average is trending down (${momentum.toFixed(1)}% vs 30-day average).`
        : `Short-term price is roughly flat vs the 30-day average (${momentum.toFixed(1)}%).`
    );

    if (clampedPosition < 0.4 && momentum < -10) {
      score *= 0.5;
      reasons.push("Caution: cheap but still falling — could be a falling knife, not a bottom yet.");
    }
    if (clampedPosition > 0.6 && momentum > 10) {
      score -= 15;
      reasons.push("Price is both expensive and overheating — higher chance of a pullback.");
    }
  } else {
    reasons.push("No momentum history available (Cardmarket trend data missing) — signal based on price band only.");
  }

  score = Math.max(-100, Math.min(100, score));

  let label = "HOLD";
  if (score >= 20) label = "BUY";
  else if (score <= -20) label = "SELL";

  return { label, score, reasons, band, momentum };
}

// ---------- Rendering ----------

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", isError);
}

function sortCards(cards, mode) {
  const withPrice = (c) => c.signal.band?.market ?? 0;
  const sorted = [...cards];
  switch (mode) {
    case "score-desc": sorted.sort((a, b) => b.signal.score - a.signal.score); break;
    case "score-asc": sorted.sort((a, b) => a.signal.score - b.signal.score); break;
    case "price-desc": sorted.sort((a, b) => withPrice(b) - withPrice(a)); break;
    case "price-asc": sorted.sort((a, b) => withPrice(a) - withPrice(b)); break;
    case "name": sorted.sort((a, b) => a.name.localeCompare(b.name)); break;
  }
  return sorted;
}

// Returns the top N cards for one label, ranked by strength of conviction in that
// direction: for BUY the highest positive scores first, for SELL the most negative
// first, for HOLD the scores closest to neutral first (the clearest "no strong
// signal either way" picks).
function topCardsForLabel(cards, label, n) {
  const filtered = cards.filter((c) => c.signal.label === label);
  filtered.sort((a, b) => {
    if (label === "BUY") return b.signal.score - a.signal.score;
    if (label === "SELL") return a.signal.score - b.signal.score;
    return Math.abs(a.signal.score) - Math.abs(b.signal.score);
  });
  return filtered.slice(0, n);
}

// Shared by Top Picks, search results, and the portfolio list. `actionButton`
// (optional) is appended below the signal and stops propagation so clicking
// it doesn't also open the card detail modal.
function buildCardTile(card, actionButton) {
  const { signal } = card;
  const tile = document.createElement("div");
  tile.className = "card-tile";
  tile.innerHTML = `
    <img src="${card.images?.small || ""}" alt="${card.name}" loading="lazy" />
    <div class="card-name">${card.name}</div>
    <div class="card-set">${card.set?.name || ""} · #${card.number || "?"}</div>
    <div class="price-row">
      <span>Market</span>
      <strong>${signal?.band ? fmt(signal.band.market, signal.band.currency) : "—"}</strong>
    </div>
    ${signal ? `<span class="signal ${signal.label}">${signal.label}</span>
    <div class="signal-reason">${signal.reasons[0] || ""}</div>` : ""}
  `;
  if (actionButton) {
    actionButton.addEventListener("click", (e) => e.stopPropagation());
    const actionsRow = document.createElement("div");
    actionsRow.className = "card-tile-actions";
    actionsRow.appendChild(actionButton);
    tile.appendChild(actionsRow);
  }
  tile.addEventListener("click", () => openCardDetail(card));
  return tile;
}

function renderResults() {
  const filtered = activeFilter === "ALL"
    ? [
        ...topCardsForLabel(currentCards, "BUY", TOP_N_PER_CATEGORY),
        ...topCardsForLabel(currentCards, "HOLD", TOP_N_PER_CATEGORY),
        ...topCardsForLabel(currentCards, "SELL", TOP_N_PER_CATEGORY),
      ]
    : topCardsForLabel(currentCards, activeFilter, TOP_N_PER_CATEGORY);
  const sorted = sortCards(filtered, els.sortSelect.value);
  els.results.innerHTML = "";

  if (sorted.length === 0) {
    const msg = currentCards.length === 0
      ? "No cards loaded. Try refreshing."
      : `No ${activeFilter} signals found in the current scan.`;
    els.results.innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }

  for (const card of sorted) {
    els.results.appendChild(buildCardTile(card));
  }
}

function scoreColor(score) {
  if (score >= 20) return "var(--buy)";
  if (score <= -20) return "var(--sell)";
  return "var(--hold)";
}

function buildPriceTableRows(card) {
  const rows = [];
  const tcg = card.tcgplayer?.prices;
  if (tcg) {
    for (const [variant, p] of Object.entries(tcg)) {
      rows.push(`<tr>
        <td>TCGplayer — ${variant}</td>
        <td>${fmt(p.low, "USD")}</td>
        <td>${fmt(p.mid, "USD")}</td>
        <td>${fmt(p.high, "USD")}</td>
        <td>${fmt(p.market, "USD")}</td>
      </tr>`);
    }
  }
  const cm = card.cardmarket?.prices;
  if (cm) {
    rows.push(`<tr>
      <td>Cardmarket — trend</td>
      <td>${fmt(cm.lowPrice, "EUR")}</td>
      <td>${fmt(cm.avg7, "EUR")}</td>
      <td>${fmt(cm.avg30, "EUR")}</td>
      <td>${fmt(cm.trendPrice, "EUR")}</td>
    </tr>`);
  }
  return rows.join("");
}

function openCardDetail(card) {
  const { signal } = card;
  const pct = Math.round(((signal.score + 100) / 200) * 100);

  els.cardModalContent.innerHTML = `
    <div class="detail-header">
      <img src="${card.images?.large || card.images?.small || ""}" alt="${card.name}" />
      <div>
        <h2>${card.name}</h2>
        <div class="card-set">${card.set?.name || ""} · #${card.number || "?"} · ${card.rarity || ""}</div>
        <span class="signal ${signal.label}" style="margin-top:10px;">${signal.label}</span>
        <div class="score-bar-track">
          <div class="score-bar-fill" style="width:${pct}%; background:${scoreColor(signal.score)};"></div>
        </div>
        <div class="card-set">AI score: ${signal.score.toFixed(0)} (−100 strong sell … +100 strong buy)</div>
      </div>
    </div>

    <h3>Why this signal</h3>
    <ul class="explain-list">
      ${signal.reasons.map((r) => `<li>${r}</li>`).join("")}
    </ul>

    <h3>Price comparison</h3>
    <table class="price-table">
      <thead><tr><th>Source</th><th>Low</th><th>Mid / 7d</th><th>High / 30d</th><th>Market / Trend</th></tr></thead>
      <tbody>${buildPriceTableRows(card)}</tbody>
    </table>
  `;

  els.cardModal.classList.remove("hidden");
}

// ---------- Top 20 flow ----------

// Bulk commons under this price are excluded from ranking: at sub-$2 prices, tiny
// absolute price noise (a few cents) produces huge percentage swings that look like
// a strong signal but aren't a meaningful buy/sell decision for anyone.
const MIN_MARKET_PRICE = 2;

function formatAge(fetchedAt) {
  if (!fetchedAt) return "just now";
  const minutes = Math.round((Date.now() - fetchedAt) / 60000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 min ago";
  return `${minutes} min ago`;
}

async function loadCards() {
  els.refreshBtn.disabled = true;
  setStatus(`Loading price signals for ${BASKET_SIZE} popular Pokémon…`);
  els.results.innerHTML = "";
  try {
    const { cards, fetchedAt, stale } = await fetchTopPool((attempt, total) => {
      setStatus(`Pokémon TCG API is being slow/flaky — retrying (${attempt}/${total})…`);
    });
    currentCards = cards
      .map((card) => ({ ...card, signal: computeSignal(card) }))
      .filter((card) => (card.signal.band?.market ?? 0) >= MIN_MARKET_PRICE);

    const buyCount = currentCards.filter((c) => c.signal.label === "BUY").length;
    const holdCount = currentCards.filter((c) => c.signal.label === "HOLD").length;
    const sellCount = currentCards.filter((c) => c.signal.label === "SELL").length;
    const ageNote = stale
      ? ` (live refresh failed — showing cached data from ${formatAge(fetchedAt)})`
      : ` (data from ${formatAge(fetchedAt)})`;
    setStatus(`Scanned ${currentCards.length} cards${ageNote} — ${buyCount} buy, ${holdCount} hold, ${sellCount} sell signals. Showing top ${TOP_N_PER_CATEGORY} per category.`, stale);
    renderResults();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    els.refreshBtn.disabled = false;
  }
}

// ---------- Auth ----------

function showAuthScreen() {
  els.authScreen.classList.remove("hidden");
  els.appRoot.classList.add("hidden");
}

function showApp(username) {
  els.authScreen.classList.add("hidden");
  els.appRoot.classList.remove("hidden");
  els.currentUser.textContent = username ? `👤 ${username}` : "";
}

// No email anywhere. Accounts live in our own "users" table (see
// supabase-schema.sql) with passwords hashed inside Postgres via pgcrypto —
// the hash is never sent to or seen by the browser. We call two narrow RPC
// functions (signup_user / login_user) instead of Supabase's Auth service.
//
// Trade-off: since there's no backend session/JWT, "being logged in" is
// just a flag we keep in localStorage — nothing server-side enforces it on
// later requests. That's fine here because there's no actually-sensitive
// data behind the login (card prices are public data anyway); it just gates
// the UI, the way the original app's Refresh/filter state already does.
const SESSION_KEY = "pkmn_user_session";

function validateUsername(username) {
  if (!username || username.length < 3 || username.length > 40) {
    return "Username must be 3–40 characters.";
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(username)) {
    return "Username can only contain letters, numbers, underscore, dot, and dash.";
  }
  return null;
}

function saveSession(username, sessionToken) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ username, sessionToken }));
}

function readSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getSessionToken() {
  return readSession()?.sessionToken || null;
}

const CONFIG_MISSING_MESSAGE =
  "Supabase isn't configured yet. Open config.js and paste in your Project URL and anon key from the Supabase dashboard (Project Settings → API), and run supabase-schema.sql in the SQL Editor.";

async function checkAuth() {
  if (!supabaseConfigured) {
    showAuthScreen();
    els.loginError.textContent = CONFIG_MISSING_MESSAGE;
    return;
  }
  const session = readSession();
  if (!session) return showAuthScreen();
  showApp(session.username);
  loadFxRates();
  loadCards();
}

els.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.loginError.textContent = "";
  if (!supabaseConfigured) {
    els.loginError.textContent = CONFIG_MISSING_MESSAGE;
    return;
  }
  const username = els.loginUsername.value.trim();
  const { data, error } = await sb.rpc("login_user", {
    p_username: username,
    p_password: els.loginPassword.value,
  });
  if (error) {
    els.loginError.textContent = error.message;
    return;
  }
  saveSession(data.username, data.session_token);
  showApp(data.username);
  loadFxRates();
  loadCards();
});

els.signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  els.signupError.textContent = "";
  if (!supabaseConfigured) {
    els.signupError.textContent = CONFIG_MISSING_MESSAGE;
    return;
  }
  const username = els.signupUsername.value.trim();
  const usernameError = validateUsername(username);
  if (usernameError) {
    els.signupError.textContent = usernameError;
    return;
  }
  const { data, error } = await sb.rpc("signup_user", {
    p_username: username,
    p_password: els.signupPassword.value,
  });
  if (error) {
    els.signupError.textContent = error.message;
    return;
  }
  saveSession(data.username, data.session_token);
  showApp(data.username);
  loadFxRates();
  loadCards();
});

els.showSignup.addEventListener("click", (e) => {
  e.preventDefault();
  els.loginError.textContent = "";
  els.loginForm.classList.add("hidden");
  els.signupForm.classList.remove("hidden");
});

els.showLogin.addEventListener("click", (e) => {
  e.preventDefault();
  els.signupError.textContent = "";
  els.signupForm.classList.add("hidden");
  els.loginForm.classList.remove("hidden");
});

els.logoutBtn.addEventListener("click", () => {
  localStorage.removeItem(SESSION_KEY);
  els.loginUsername.value = "";
  els.loginPassword.value = "";
  showAuthScreen();
});

// ---------- Tabs ----------

els.tabNav.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  const targetId = btn.dataset.tab;
  for (const b of els.tabNav.querySelectorAll(".tab-btn")) {
    b.classList.toggle("active", b === btn);
  }
  els.topPicksTab.classList.toggle("hidden", targetId !== "topPicksTab");
  els.portfolioTab.classList.toggle("hidden", targetId !== "portfolioTab");
  if (targetId === "portfolioTab") loadPortfolio();
});

// ---------- Card search (Portfolio tab) ----------

async function doCardSearch() {
  const query = els.cardSearchInput.value.trim();
  if (!query) return;

  // Open the popup immediately with a loading state — the API can take
  // 10-20+ seconds under load, and waiting for results before showing
  // anything looked exactly like the click didn't register.
  els.cardSearchBtn.disabled = true;
  els.searchResultsGrid.innerHTML = "";
  els.searchStatus.textContent = `Searching for "${query}"…`;
  els.searchResultsModal.classList.remove("hidden");

  let rawResults, totalCount;
  try {
    ({ cards: rawResults, totalCount } = await searchCards(query, (attempt, total) => {
      els.searchStatus.textContent = `Pokémon TCG API is being slow/flaky — retrying (${attempt}/${total})…`;
    }));
  } catch (err) {
    els.searchStatus.textContent = err.message;
    return;
  } finally {
    els.cardSearchBtn.disabled = false;
  }

  if (rawResults.length === 0) {
    els.searchStatus.textContent = `No cards found matching "${query}".`;
    return;
  }
  els.searchStatus.textContent = totalCount > rawResults.length
    ? `Showing ${rawResults.length} of ${totalCount} matching cards.`
    : `Found ${rawResults.length} card${rawResults.length === 1 ? "" : "s"}.`;

  for (const rawCard of rawResults) {
    const card = { ...rawCard, signal: computeSignal(rawCard) };
    const addBtn = document.createElement("button");
    addBtn.className = "add-btn";
    addBtn.textContent = "+ Add";
    addBtn.addEventListener("click", () => addToPortfolio(card, addBtn));
    els.searchResultsGrid.appendChild(buildCardTile(card, addBtn));
  }
}

els.cardSearchBtn.addEventListener("click", doCardSearch);
els.cardSearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doCardSearch();
});
els.closeSearchResultsBtn.addEventListener("click", () => {
  els.searchResultsModal.classList.add("hidden");
});

// ---------- Portfolio (saved cards, backed by Supabase) ----------

async function addToPortfolio(card, addBtn) {
  addBtn.disabled = true;
  addBtn.textContent = "Adding…";
  const { error } = await sb.rpc("add_portfolio_card", {
    p_session_token: getSessionToken(),
    p_card_id: card.id,
    p_card_name: card.name,
    p_card_image: card.images?.small || null,
    p_set_name: card.set?.name || null,
  });
  if (error) {
    els.searchStatus.textContent = error.message;
    addBtn.disabled = false;
    addBtn.textContent = "+ Add";
    return;
  }
  addBtn.textContent = "✓ Added";
  loadPortfolio();
}

async function removePortfolioCard(cardId, removeBtn) {
  removeBtn.disabled = true;
  const { error } = await sb.rpc("remove_portfolio_card", {
    p_session_token: getSessionToken(),
    p_card_id: cardId,
  });
  if (error) {
    els.portfolioStatus.textContent = error.message;
    removeBtn.disabled = false;
    return;
  }
  loadPortfolio();
}

async function loadPortfolio() {
  els.portfolioResults.innerHTML = "";
  els.portfolioStatus.textContent = "Loading your portfolio…";

  const { data: rows, error } = await sb.rpc("get_portfolio", { p_session_token: getSessionToken() });
  if (error) {
    els.portfolioStatus.textContent = error.message;
    return;
  }
  if (!rows || rows.length === 0) {
    els.portfolioStatus.textContent = "No cards saved yet — search above to add some.";
    return;
  }

  els.portfolioStatus.textContent = `Loading live prices for ${rows.length} saved card${rows.length === 1 ? "" : "s"}…`;

  const cards = [];
  for (const row of rows) {
    let rawCard = readCardCache(row.card_id);
    if (!rawCard) {
      try {
        rawCard = await fetchCardById(row.card_id);
        if (rawCard) writeCardCache(row.card_id, rawCard);
      } catch {
        rawCard = null;
      }
    }
    cards.push(
      rawCard
        ? { ...rawCard, signal: computeSignal(rawCard) }
        : {
            id: row.card_id,
            name: row.card_name,
            images: { small: row.card_image },
            set: { name: row.set_name },
            signal: { label: "HOLD", score: 0, reasons: ["Couldn't load a live price right now."], band: null },
          }
    );
  }

  els.portfolioStatus.textContent = `${cards.length} card${cards.length === 1 ? "" : "s"} in your portfolio.`;
  els.portfolioResults.innerHTML = "";
  for (const card of cards) {
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "✕ Remove";
    removeBtn.addEventListener("click", () => removePortfolioCard(card.id, removeBtn));
    els.portfolioResults.appendChild(buildCardTile(card, removeBtn));
  }
}

// ---------- Events ----------

els.refreshBtn.addEventListener("click", loadCards);
els.sortSelect.addEventListener("change", renderResults);
els.currencySelect.addEventListener("change", () => {
  selectedCurrency = els.currencySelect.value;
  renderResults();
});

els.filterPills.addEventListener("click", (e) => {
  const btn = e.target.closest(".pill");
  if (!btn) return;
  activeFilter = btn.dataset.filter;
  for (const pill of els.filterPills.querySelectorAll(".pill")) {
    pill.classList.toggle("active", pill === btn);
  }
  renderResults();
});

els.settingsBtn.addEventListener("click", () => {
  els.apiKeyInput.value = localStorage.getItem(STORAGE_KEY) || "";
  els.settingsModal.classList.remove("hidden");
});
els.closeSettingsBtn.addEventListener("click", () => els.settingsModal.classList.add("hidden"));
els.saveSettingsBtn.addEventListener("click", () => {
  const val = els.apiKeyInput.value.trim();
  if (val) localStorage.setItem(STORAGE_KEY, val);
  else localStorage.removeItem(STORAGE_KEY);
  els.settingsModal.classList.add("hidden");
});

for (const modal of [els.settingsModal, els.cardModal, els.searchResultsModal]) {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
}

// ---------- Init ----------

checkAuth();
