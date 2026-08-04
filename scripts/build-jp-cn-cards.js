// One-off build script — generates cards-jp/*.json and cards-cn/*.json
// (Japanese and Traditional Chinese card data from TCGdex), plus
// dex-index.json mapping English species name -> National Pokédex number.
//
//   node scripts/build-jp-cn-cards.js
//
// Unlike the English build, TCGdex's list endpoint doesn't include image/
// pricing/dexId — those only come from the per-card detail endpoint, so
// this needs one request per card (~15,600 total across both languages).
// Requests run with limited concurrency and retry-with-skip on failures,
// same resilience pattern as build-cards-json.js.
//
// Cards are grouped by National Pokédex number (stable across languages)
// rather than by name, since Japanese/Chinese names are in non-Latin
// script and can't be slugified the way English names are. Non-Pokemon
// cards (Trainer/Energy, no dexId) are grouped by their own card ID.

const fs = require("fs");
const path = require("path");

const TCGDEX_BASE = "https://api.tcgdex.net/v2";
const LANGUAGES = [
  { code: "ja", outDir: "cards-jp" },
  { code: "zh-tw", outDir: "cards-cn" },
];
const CONCURRENCY = 8;
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchJsonWithRetry(url) {
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === RETRY_ATTEMPTS) return null;
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
  }
  return null;
}

// ---------- Step 1: species dex-index from PokeAPI ----------

async function buildDexIndex() {
  console.log("Fetching species list from PokeAPI...");
  const body = await fetchJsonWithRetry("https://pokeapi.co/api/v2/pokemon-species?limit=1500");
  if (!body) throw new Error("Could not fetch PokeAPI species list.");

  const index = {};
  body.results.forEach((species, i) => {
    const dexNumber = i + 1; // PokeAPI returns species in National Dex order
    const slug = slugify(species.name);
    if (slug) index[slug] = dexNumber;
  });
  console.log(`Built dex-index with ${Object.keys(index).length} species.\n`);
  return index;
}

// ---------- Step 2: fetch a language's cards, grouped by dexId ----------

async function runPool(items, worker, onProgress) {
  let cursor = 0;
  let done = 0;
  async function next() {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i]);
      done++;
      if (done % 200 === 0) onProgress(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, next));
  onProgress(done, items.length);
}

function trimCard(card) {
  return {
    id: card.id,
    name: card.name,
    number: card.localId,
    rarity: card.rarity,
    image: card.image ? `${card.image}/high.png` : undefined,
    set: card.set ? { name: card.set.name } : undefined,
    dexId: card.dexId || [],
    pricing: card.pricing || undefined,
  };
}

async function buildLanguage(lang, outDir) {
  console.log(`--- ${lang} ---`);
  const list = await fetchJsonWithRetry(`${TCGDEX_BASE}/${lang}/cards`);
  if (!list) throw new Error(`Could not fetch card list for ${lang}.`);
  console.log(`${list.length} cards to fetch in detail.`);

  const byDex = new Map(); // dexNumber -> cards[]
  const byId = new Map(); // card id -> card (no dexId, e.g. Trainer/Energy)
  const failed = [];

  const worker = async (item) => {
    const detail = await fetchJsonWithRetry(`${TCGDEX_BASE}/${lang}/cards/${item.id}`);
    if (!detail) {
      failed.push(item.id);
      return;
    }
    const card = trimCard(detail);
    const dex = detail.dexId?.[0];
    if (dex) {
      if (!byDex.has(dex)) byDex.set(dex, []);
      byDex.get(dex).push(card);
    } else {
      byId.set(card.id, card);
    }
  };

  await runPool(list, worker, (done, total) => console.log(`  ${done}/${total} fetched...`));

  if (failed.length > 0) {
    console.log(`Retrying ${failed.length} failed card(s)...`);
    for (const id of failed) {
      const detail = await fetchJsonWithRetry(`${TCGDEX_BASE}/${lang}/cards/${id}`);
      if (detail) {
        const card = trimCard(detail);
        const dex = detail.dexId?.[0];
        if (dex) {
          if (!byDex.has(dex)) byDex.set(dex, []);
          byDex.get(dex).push(card);
        } else {
          byId.set(card.id, card);
        }
      }
    }
  }

  const outPath = path.join(__dirname, "..", outDir);
  fs.mkdirSync(outPath, { recursive: true });
  for (const file of fs.readdirSync(outPath)) {
    if (file.endsWith(".json")) fs.unlinkSync(path.join(outPath, file));
  }

  for (const [dex, cards] of byDex) {
    const filename = String(dex).padStart(4, "0") + ".json";
    fs.writeFileSync(path.join(outPath, filename), JSON.stringify({ dexId: dex, cards }));
  }
  for (const [id, card] of byId) {
    fs.writeFileSync(path.join(outPath, `${slugify(id)}.json`), JSON.stringify({ cards: [card] }));
  }

  const dexIndexList = Array.from(byDex.keys()).sort((a, b) => a - b);
  fs.writeFileSync(path.join(outPath, "dex-list.json"), JSON.stringify(dexIndexList));

  console.log(`${lang}: wrote ${byDex.size} species files + ${byId.size} non-Pokemon files.\n`);
}

async function main() {
  const dexIndex = await buildDexIndex();
  fs.writeFileSync(path.join(__dirname, "..", "dex-index.json"), JSON.stringify(dexIndex));

  for (const { code, outDir } of LANGUAGES) {
    await buildLanguage(code, outDir);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("\nBuild failed:", err.message);
  process.exit(1);
});
