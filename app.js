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
  loginEmail: document.getElementById("loginEmail"),
  loginPassword: document.getElementById("loginPassword"),
  loginError: document.getElementById("loginError"),
  signupForm: document.getElementById("signupForm"),
  signupEmail: document.getElementById("signupEmail"),
  signupPassword: document.getElementById("signupPassword"),
  signupError: document.getElementById("signupError"),
  showSignup: document.getElementById("showSignup"),
  showLogin: document.getElementById("showLogin"),
  logoutBtn: document.getElementById("logoutBtn"),
  currentUser: document.getElementById("currentUser"),
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
const REQUEST_TIMEOUT_MS = 15000;

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

async function fetchTopPool() {
  const cached = readCardsCache();
  if (cached) {
    return { cards: cached.cards, fetchedAt: cached.fetchedAt, stale: false };
  }

  const key = localStorage.getItem(STORAGE_KEY);
  const headers = key ? { "X-Api-Key": key } : {};
  const query = "(" + POPULAR_POKEMON.map((n) => `name:"${n}*"`).join(" OR ") + ")";
  const url = `${POKEMON_API_BASE}?q=${encodeURIComponent(query)}&pageSize=100&orderBy=-set.releaseDate`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    throw err.name === "AbortError"
      ? new Error("The Pokémon TCG API took too long to respond. Try refreshing again.")
      : new Error("Couldn't reach the Pokémon TCG API. Check your connection.");
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`Pokémon TCG API error (${res.status}).`);
  }
  const body = await res.json().catch(() => ({}));

  const seen = new Set();
  const cards = (body.data || []).filter((card) => {
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });

  const fetchedAt = Date.now();
  writeCardsCache(cards, fetchedAt);
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
    const { signal } = card;
    const tile = document.createElement("div");
    tile.className = "card-tile";
    tile.innerHTML = `
      <img src="${card.images?.small || ""}" alt="${card.name}" loading="lazy" />
      <div class="card-name">${card.name}</div>
      <div class="card-set">${card.set?.name || ""} · #${card.number || "?"}</div>
      <div class="price-row">
        <span>Market</span>
        <strong>${signal.band ? fmt(signal.band.market, signal.band.currency) : "—"}</strong>
      </div>
      <span class="signal ${signal.label}">${signal.label}</span>
      <div class="signal-reason">${signal.reasons[0] || ""}</div>
    `;
    tile.addEventListener("click", () => openCardDetail(card));
    els.results.appendChild(tile);
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
    const { cards, fetchedAt, stale } = await fetchTopPool();
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

const CONFIG_MISSING_MESSAGE =
  "Supabase isn't configured yet. Open config.js and paste in your Project URL and anon key from the Supabase dashboard (Project Settings → API).";

async function checkAuth() {
  if (!supabaseConfigured) {
    showAuthScreen();
    els.loginError.textContent = CONFIG_MISSING_MESSAGE;
    return;
  }
  const { data, error } = await sb.auth.getSession();
  if (error || !data.session) return showAuthScreen();
  showApp(data.session.user.email);
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
  const { data, error } = await sb.auth.signInWithPassword({
    email: els.loginEmail.value.trim(),
    password: els.loginPassword.value,
  });
  if (error) {
    els.loginError.textContent = error.message;
    return;
  }
  showApp(data.user.email);
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
  const { data, error } = await sb.auth.signUp({
    email: els.signupEmail.value.trim(),
    password: els.signupPassword.value,
  });
  if (error) {
    els.signupError.textContent = error.message;
    return;
  }
  if (!data.session) {
    // Email confirmation is enabled on the Supabase project — no session yet.
    els.signupError.textContent = "Check your email to confirm your account, then log in.";
    return;
  }
  showApp(data.user.email);
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

els.logoutBtn.addEventListener("click", async () => {
  if (supabaseConfigured) await sb.auth.signOut();
  els.loginEmail.value = "";
  els.loginPassword.value = "";
  showAuthScreen();
});

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

for (const modal of [els.settingsModal, els.cardModal]) {
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.add("hidden");
  });
}

// ---------- Init ----------

checkAuth();
