// Follow-up repair for build-jp-cn-cards.js — TCGdex's Traditional Chinese
// data often leaves dexId empty even for real Pokemon cards (verified: e.g.
// 派拉斯 / Paras had dexId: [] despite being a real Pokemon), so ~73% of
// Chinese cards landed in the non-Pokemon fallback bucket incorrectly.
//
// Fixes it using PokeAPI's zh-hant name per species (which TCGdex doesn't
// provide) to identify which "non-Pokemon" files are actually miscategorized
// Pokemon, and moves them into the correct dex-numbered file.
//
//   node scripts/repair-cn-dex.js

const fs = require("fs");
const path = require("path");

const CN_DIR = path.join(__dirname, "..", "data", "cards-cn");
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 2000;
const CONCURRENCY = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function runPool(items, worker) {
  let cursor = 0;
  let done = 0;
  async function next() {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i]);
      done++;
      if (done % 100 === 0) console.log(`  ${done}/${items.length} species checked...`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, next));
}

async function main() {
  console.log("Building zh-hant name -> dex number map from PokeAPI...");
  const listBody = await fetchJsonWithRetry("https://pokeapi.co/api/v2/pokemon-species?limit=1500");
  if (!listBody) throw new Error("Could not fetch species list.");

  const nameToDex = new Map(); // Chinese name -> dex number

  await runPool(listBody.results, async (species, idx) => {
    const detail = await fetchJsonWithRetry(species.url);
    if (!detail) return;
    const zhName = detail.names.find((n) => n.language.name === "zh-hant")?.name;
    if (zhName) nameToDex.set(zhName, detail.id);
  });

  console.log(`Got ${nameToDex.size} Chinese species names.\n`);

  // Load every non-dex-numbered card file and check if its name matches a
  // known species — if so, it belongs in the dex-numbered file instead.
  const files = fs.readdirSync(CN_DIR).filter((f) => f.endsWith(".json") && f !== "dex-list.json");
  const dexFiles = new Set(files.filter((f) => /^\d{4}\.json$/.test(f)));
  const nonDexFiles = files.filter((f) => !dexFiles.has(f));

  const byDex = new Map(); // dex -> cards[] (additions to make)
  let reclassified = 0;
  const toDelete = [];

  for (const file of nonDexFiles) {
    const filePath = path.join(CN_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const card = data.cards[0];
    const dex = nameToDex.get(card.name);
    if (dex) {
      card.dexId = [dex];
      if (!byDex.has(dex)) byDex.set(dex, []);
      byDex.get(dex).push(card);
      toDelete.push(filePath);
      reclassified++;
    }
  }

  console.log(`Reclassifying ${reclassified} miscategorized cards into ${byDex.size} species files...`);

  for (const [dex, newCards] of byDex) {
    const filename = String(dex).padStart(4, "0") + ".json";
    const filePath = path.join(CN_DIR, filename);
    let existing = { dexId: dex, cards: [] };
    if (fs.existsSync(filePath)) {
      existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
    existing.cards.push(...newCards);
    fs.writeFileSync(filePath, JSON.stringify(existing));
  }

  for (const filePath of toDelete) {
    fs.unlinkSync(filePath);
  }

  // Rebuild dex-list.json with the now-complete set of species files.
  const finalDexFiles = fs.readdirSync(CN_DIR).filter((f) => /^\d{4}\.json$/.test(f));
  const dexList = finalDexFiles.map((f) => parseInt(f, 10)).sort((a, b) => a - b);
  fs.writeFileSync(path.join(CN_DIR, "dex-list.json"), JSON.stringify(dexList));

  console.log(`\nDone. ${dexList.length} species files now (was ${dexFiles.size}). ${nonDexFiles.length - reclassified} files left as genuine non-Pokemon cards.`);
}

main().catch((err) => {
  console.error("\nRepair failed:", err.message);
  process.exit(1);
});
