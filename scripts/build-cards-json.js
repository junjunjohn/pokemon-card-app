// One-off build script — generates data/cards/*.json, a directory of small
// static files (one per unique card name) plus data/cards/index.json, all
// committed to the repo and served by GitHub Pages like any other file.
// No database, no secret keys, nothing to configure.
//
//   node scripts/build-cards-json.js
//
// Re-run this and commit the result whenever prices feel stale.
//
// Each card is trimmed to only the fields the app actually reads (see
// computeSignal/getPriceBand/getMomentumPct/openCardDetail in app.js) to
// keep file sizes small — the full API response per card includes a lot
// the app never uses (attacks, abilities, rules text, legalities, etc.).
//
// Cards are grouped by slugify(card.name) — e.g. "Pikachu ex" and
// "Pikachu VMAX" each get their own file, separate from "Pikachu" — so a
// search only has to fetch the handful of small files that actually
// matched, never the whole catalog. app.js's slugify() must stay in sync
// with this one.

const fs = require("fs");
const path = require("path");

const POKEMON_API_BASE = "https://api.pokemontcg.io/v2/cards";
const PAGE_SIZE = 250;
const RETRY_ATTEMPTS = 6; // this is a one-off background job, not user-facing — we can afford patience
const RETRY_BASE_DELAY_MS = 3000;
const DELAY_BETWEEN_PAGES_MS = 600;
const OUTPUT_DIR = path.join(__dirname, "..", "data", "cards");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keep in sync with slugify() in app.js.
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Returns null instead of throwing on total failure — a single stubborn page
// (this API can fail 4+ retries in a row during a bad stretch) shouldn't
// lose all the progress made on every other page. Failed pages are
// collected and retried again after the full first pass.
async function fetchPage(page) {
  const url = `${POKEMON_API_BASE}?page=${page}&pageSize=${PAGE_SIZE}`;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`API error ${res.status} on page ${page}`);
      return await res.json();
    } catch (err) {
      console.warn(`  page ${page} attempt ${attempt}/${RETRY_ATTEMPTS} failed: ${err.message}`);
      if (attempt < RETRY_ATTEMPTS) await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
  }
  return null;
}

function trimCard(card) {
  return {
    id: card.id,
    name: card.name,
    number: card.number,
    rarity: card.rarity,
    images: card.images ? { small: card.images.small, large: card.images.large } : undefined,
    set: card.set ? { name: card.set.name } : undefined,
    tcgplayer: card.tcgplayer ? { prices: card.tcgplayer.prices } : undefined,
    cardmarket: card.cardmarket ? { prices: card.cardmarket.prices } : undefined,
  };
}

async function main() {
  console.log("Fetching page 1 to find total card count...");
  let first = await fetchPage(1);
  while (!first) {
    console.warn("Page 1 failed completely — waiting 15s and trying again (need this one to know the total).");
    await sleep(15000);
    first = await fetchPage(1);
  }
  const totalCount = first.totalCount ?? first.data.length;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  console.log(`Total cards: ${totalCount} across ${totalPages} pages.\n`);

  // slug -> array of trimmed cards
  const groups = new Map();
  const failedPages = [];

  const addPage = (body, page) => {
    for (const card of body.data || []) {
      const slug = slugify(card.name);
      if (!slug) continue;
      if (!groups.has(slug)) groups.set(slug, []);
      groups.get(slug).push(trimCard(card));
    }
    console.log(`Page ${page}/${totalPages} — ${groups.size} unique names so far.`);
  };

  addPage(first, 1);
  await sleep(DELAY_BETWEEN_PAGES_MS);

  for (let page = 2; page <= totalPages; page++) {
    const body = await fetchPage(page);
    if (body) {
      addPage(body, page);
    } else {
      console.warn(`Page ${page} failed after ${RETRY_ATTEMPTS} attempts — skipping for now, will retry at the end.`);
      failedPages.push(page);
    }
    await sleep(DELAY_BETWEEN_PAGES_MS);
  }

  if (failedPages.length > 0) {
    console.log(`\nRetrying ${failedPages.length} page(s) that failed on the first pass: ${failedPages.join(", ")}`);
    const stillFailed = [];
    for (const page of failedPages) {
      const body = await fetchPage(page);
      if (body) addPage(body, page);
      else stillFailed.push(page);
      await sleep(DELAY_BETWEEN_PAGES_MS);
    }
    if (stillFailed.length > 0) {
      console.warn(`\nWarning: ${stillFailed.length} page(s) never succeeded (pages: ${stillFailed.join(", ")}). Some cards will be missing — safe to re-run this script later to fill the gaps.`);
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const file of fs.readdirSync(OUTPUT_DIR)) {
    if (file.endsWith(".json")) fs.unlinkSync(path.join(OUTPUT_DIR, file));
  }

  let totalBytes = 0;
  for (const [slug, cards] of groups) {
    const json = JSON.stringify({ name: cards[0].name, cards });
    fs.writeFileSync(path.join(OUTPUT_DIR, `${slug}.json`), json);
    totalBytes += Buffer.byteLength(json);
  }

  const index = Array.from(groups.keys()).sort();
  fs.writeFileSync(path.join(OUTPUT_DIR, "index.json"), JSON.stringify(index));

  const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);
  console.log(`\nWrote ${groups.size} card files (${totalMB} MB total) + index.json to ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});
