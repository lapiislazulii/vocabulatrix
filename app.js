const WORDS_FILE = "words_alpha.txt";
const MAX_TRIES = 25; // many words in the list aren't in any dictionary

const els = {
  status: document.getElementById("status"),
  cards: document.getElementById("cards"),
  countInput: document.getElementById("countInput"),
  btn: document.getElementById("newWordBtn"),
};

let words = [];
let busy = false;

// === Normalized model ========================================================
// Every provider returns this shape (or null if the word isn't found):
// {
//   word, phonetic, audio,
//   meanings: [{ partOfSpeech, definitions: [{definition, example}], synonyms, antonyms }],
//   origin, sourceUrls: [], source
// }

// --- Provider 1: dictionaryapi.dev (primary) ---------------------------------
async function fromDictionaryApi(word) {
  const res = await fetch(
    "https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word)
  );
  if (!res.ok) return null; // 404 = not found
  const entries = await res.json();
  if (!Array.isArray(entries) || !entries.length) return null;

  const first = entries[0];
  const meanings = [];
  for (const entry of entries) {
    for (const m of entry.meanings || []) {
      meanings.push({
        partOfSpeech: m.partOfSpeech || "",
        definitions: (m.definitions || []).map((d) => ({
          definition: d.definition,
          example: d.example || "",
        })),
        synonyms: m.synonyms || [],
        antonyms: m.antonyms || [],
      });
    }
  }
  if (!meanings.length) return null;

  const phonetics = first.phonetics || [];
  return {
    word: first.word,
    phonetic: first.phonetic || (phonetics.find((p) => p.text) || {}).text || "",
    audio: (phonetics.find((p) => p.audio) || {}).audio || null,
    meanings,
    origin: entries.map((e) => e.origin).find(Boolean) || "",
    sourceUrls: [...new Set(entries.flatMap((e) => e.sourceUrls || []))],
    source: "dictionaryapi.dev",
  };
}

// --- Provider 2: Wiktionary REST ---------------------------------------------
async function fromWiktionary(word) {
  const res = await fetch(
    "https://en.wiktionary.org/api/rest_v1/page/definition/" + encodeURIComponent(word)
  );
  if (!res.ok) return null;
  const data = await res.json();
  const groups = data.en;
  if (!Array.isArray(groups) || !groups.length) return null;

  const meanings = groups
    .map((g) => ({
      partOfSpeech: (g.partOfSpeech || "").toLowerCase(),
      definitions: (g.definitions || [])
        .map((d) => ({
          definition: stripHtml(d.definition),
          example:
            d.examples && d.examples.length ? stripHtml(d.examples[0]) : "",
        }))
        .filter((d) => d.definition),
      synonyms: [],
      antonyms: [],
    }))
    .filter((m) => m.definitions.length);
  if (!meanings.length) return null;

  return {
    word,
    phonetic: "",
    audio: null,
    meanings,
    origin: "",
    sourceUrls: ["https://en.wiktionary.org/wiki/" + encodeURIComponent(word)],
    source: "Wiktionary",
  };
}

// --- Provider 3: Datamuse ----------------------------------------------------
const POS_MAP = { n: "noun", v: "verb", adj: "adjective", adv: "adverb", u: "" };

async function fromDatamuse(word) {
  const res = await fetch(
    "https://api.datamuse.com/words?sp=" + encodeURIComponent(word) + "&md=dp&max=1"
  );
  if (!res.ok) return null;
  const data = await res.json();
  const entry = data.find((d) => d.word.toLowerCase() === word.toLowerCase());
  if (!entry || !entry.defs || !entry.defs.length) return null;

  // Datamuse packs each def as "pos\tdefinition text" — group by part of speech.
  const byPos = new Map();
  for (const raw of entry.defs) {
    const tab = raw.indexOf("\t");
    const abbr = tab === -1 ? "" : raw.slice(0, tab);
    const text = tab === -1 ? raw : raw.slice(tab + 1);
    const pos = POS_MAP[abbr] ?? abbr;
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push({ definition: text.trim(), example: "" });
  }
  const meanings = [...byPos].map(([partOfSpeech, definitions]) => ({
    partOfSpeech,
    definitions,
    synonyms: [],
    antonyms: [],
  }));

  return {
    word: entry.word,
    phonetic: "",
    audio: null,
    meanings,
    origin: "",
    sourceUrls: ["https://www.datamuse.com/api/"],
    source: "Datamuse",
  };
}

const PROVIDERS = [fromDictionaryApi, fromWiktionary, fromDatamuse];

// Try each provider in order until one has a definition.
async function lookup(word) {
  for (const provider of PROVIDERS) {
    try {
      const model = await provider(word);
      if (model) return model;
    } catch (err) {
      // network/parse hiccup — fall through to the next provider
    }
  }
  return null;
}

// --- Enrichment: etymology + IPA from Wiktionary's rendered article ----------
// dictionaryapi.dev almost never fills `origin`, and the Wiktionary/Datamuse
// definition paths carry no phonetics or etymology at all. Wiktionary's full
// page has both, so when the chosen model is missing either, we scrape it to
// fill the gap. Skipped entirely when the model already has both.
async function enrich(model) {
  if (model.phonetic && model.origin) return model;
  try {
    const extra = await wiktionaryExtras(model.word);
    if (extra) {
      if (!model.phonetic && extra.phonetic) model.phonetic = extra.phonetic;
      if (!model.origin && extra.origin) model.origin = extra.origin;
    }
  } catch (err) {
    // enrichment is best-effort — leave the model as-is
  }
  return model;
}

async function wiktionaryExtras(word) {
  const res = await fetch(
    "https://en.wiktionary.org/w/api.php?action=parse&prop=text" +
      "&format=json&formatversion=2&origin=*&page=" +
      encodeURIComponent(word)
  );
  if (!res.ok) return null;
  const data = await res.json();
  const html = data && data.parse && data.parse.text;
  if (!html) return null;

  const doc = document.createElement("div");
  doc.innerHTML = html;
  doc.querySelectorAll("style, script").forEach((el) => el.remove());

  return { phonetic: extractIpa(doc), origin: extractEtymology(doc) };
}

function extractIpa(doc) {
  for (const span of doc.querySelectorAll("span.IPA")) {
    const text = (span.textContent || "").trim();
    if (text.startsWith("/") || text.startsWith("[")) return text;
  }
  return "";
}

function extractEtymology(doc) {
  // Wiktionary wraps each heading in <div class="mw-heading"> and gives the
  // <h*> an id like "Etymology" or "Etymology_1" (when a word has several).
  const heading = [...doc.querySelectorAll("h2, h3, h4")].find((h) =>
    (h.id || "").toLowerCase().startsWith("etymology")
  );
  if (!heading) return "";
  const start = heading.closest(".mw-heading") || heading;
  const parts = [];
  for (let node = start.nextElementSibling; node; node = node.nextElementSibling) {
    if (node.classList.contains("mw-heading") || /^H[1-6]$/.test(node.tagName)) break;
    if (node.tagName === "P") {
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (text) parts.push(text);
    }
  }
  return parts.join(" ");
}

// --- Helpers -----------------------------------------------------------------
function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  // Wiktionary embeds <style>/<script> blocks whose text would otherwise
  // leak into textContent (e.g. ".mw-parser-output .defdate{...}").
  tmp.querySelectorAll("style, script").forEach((el) => el.remove());
  return (tmp.textContent || "").replace(/\s+/g, " ").trim();
}

const randomWord = () => words[Math.floor(Math.random() * words.length)];

// --- Load the word list once -------------------------------------------------
async function loadWords() {
  try {
    const res = await fetch(WORDS_FILE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    words = text.split(/\r?\n/).filter(Boolean);
    els.status.textContent = `Loaded ${words.length.toLocaleString()} words. Hit “New Word”.`;
    els.btn.disabled = false;
  } catch (err) {
    els.status.classList.add("error");
    els.status.textContent =
      `Could not load ${WORDS_FILE}. Are you running this from a local server? (${err.message})`;
  }
}

// Pick random words until one resolves through some provider.
async function fetchDefinedWord() {
  for (let i = 0; i < MAX_TRIES; i++) {
    const word = randomWord();
    const model = await lookup(word);
    if (model) return enrich(model);
  }
  return null;
}

// --- Render ------------------------------------------------------------------
// Build a self-contained card element for one word. Each card owns its own
// audio button so several can live in the grid at once.
function buildCard(model) {
  const card = document.createElement("article");
  card.className = "result";

  const head = document.createElement("div");
  head.className = "word-head";

  const word = document.createElement("h2");
  word.className = "word";
  word.textContent = model.word;
  head.appendChild(word);

  if (model.phonetic) {
    const phonetic = document.createElement("span");
    phonetic.className = "phonetic";
    phonetic.textContent = model.phonetic;
    head.appendChild(phonetic);
  }

  if (model.audio) {
    const audioBtn = document.createElement("button");
    audioBtn.className = "audio-btn";
    audioBtn.title = "Play pronunciation";
    audioBtn.textContent = "▶";
    audioBtn.addEventListener("click", () => {
      new Audio(model.audio).play().catch(() => {});
    });
    head.appendChild(audioBtn);
  }
  card.appendChild(head);

  const meanings = document.createElement("div");
  meanings.className = "meanings";
  for (const meaning of model.meanings) {
    meanings.appendChild(renderMeaning(meaning));
  }
  card.appendChild(meanings);

  if (model.origin) {
    const origin = document.createElement("div");
    origin.className = "origin";
    origin.textContent = `Etymology: ${model.origin}`;
    card.appendChild(origin);
  }

  const parts = [];
  if (model.source) parts.push(`via ${model.source}`);
  for (const u of model.sourceUrls) {
    parts.push(`<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
  }
  if (parts.length) {
    const sourceUrls = document.createElement("div");
    sourceUrls.className = "source-urls";
    sourceUrls.innerHTML = "Source: " + parts.join(" · ");
    card.appendChild(sourceUrls);
  }

  return card;
}

function renderMeaning(meaning) {
  const wrap = document.createElement("div");
  wrap.className = "meaning";

  if (meaning.partOfSpeech) {
    const pos = document.createElement("div");
    pos.className = "pos";
    pos.textContent = meaning.partOfSpeech;
    wrap.appendChild(pos);
  }

  const list = document.createElement("ol");
  list.className = "defs";
  for (const d of meaning.definitions) {
    const li = document.createElement("li");
    li.textContent = d.definition;
    if (d.example) {
      const ex = document.createElement("div");
      ex.className = "example";
      ex.textContent = `“${d.example}”`;
      li.appendChild(ex);
    }
    list.appendChild(li);
  }
  wrap.appendChild(list);

  if (meaning.synonyms?.length) wrap.appendChild(relRow("Synonyms", meaning.synonyms));
  if (meaning.antonyms?.length) wrap.appendChild(relRow("Antonyms", meaning.antonyms));

  return wrap;
}

function relRow(label, items) {
  const row = document.createElement("div");
  row.className = "rel";
  const strong = document.createElement("strong");
  strong.textContent = label + ": ";
  row.appendChild(strong);
  for (const item of items.slice(0, 12)) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = item;
    row.appendChild(chip);
  }
  return row;
}

// --- Masonry layout + spawn animation ----------------------------------------
const GAP = 20; // must match the column gap in style.css
const COL_MIN = 340; // target card width; drives how many columns we use
const MAX_COLS = 3; // three across reads as the most balanced
const STAGGER = 85; // ms between each card's entrance, for a cascade

// How many columns to use: as many ~COL_MIN-wide columns as fit, capped at
// MAX_COLS, and never more than the number of cards.
function columnCount(n) {
  const width = els.cards.clientWidth || els.cards.parentElement.clientWidth;
  const fit = Math.max(1, Math.floor((width + GAP) / (COL_MIN + GAP)));
  return Math.min(fit, MAX_COLS, n);
}

// Distribute cards into columns, always dropping the next card into whichever
// column is currently shortest — classic masonry packing.
function layoutCards(models) {
  els.cards.innerHTML = "";
  scrambleItems = []; // drop any in-flight scrambles from a previous batch
  liquidItems.length = 0; // drop drift state for cards from a previous batch
  hoverNodes = []; // drop hover targets (and their heat) from the previous batch
  hoverMeasured = false;
  const colCount = columnCount(models.length);

  const cols = [];
  const heights = [];
  for (let i = 0; i < colCount; i++) {
    const col = document.createElement("div");
    col.className = "col";
    els.cards.appendChild(col);
    cols.push(col);
    heights.push(0);
  }

  models.forEach((model, idx) => {
    let target = 0;
    for (let i = 1; i < colCount; i++) {
      if (heights[i] < heights[target]) target = i;
    }
    const card = buildCard(model);
    cols[target].appendChild(card);
    // Measure the real-text height, then HARD-LOCK it so the box can't resize or
    // jiggle as the scramble (intro or hover) swaps in glyphs of different widths
    // that rewrap lines. Width is already governed by the column.
    const h = card.offsetHeight;
    card.style.height = h + "px";
    lockTextBlocks(card); // cap every paragraph at its natural line count
    heights[target] += h + GAP; // measure for the next placement

    // Capture real text for hover BEFORE the scramble overwrites it with glyphs.
    registerHoverCard(card);

    // Animate after measuring (transforms don't change offsetHeight). The whole
    // loop runs in one frame, so the backwards-filled animation hides the card
    // before the browser ever paints it — no flash at full opacity.
    spawnCard(card, idx);
    scrambleCard(card, idx * STAGGER + 260);
    registerLiquid(card); // give the border ring its own organic drift
  });

  // Hold off measuring hover geometry until the intro (stagger + cascade + node
  // resolve) settles, since transforms and glyph-cycling would skew positions.
  const introMs = (models.length - 1) * STAGGER + 260 + CASCADE + NODE_DUR;
  hoverReadyAt = performance.now() + introMs + 150;
}

// Lock each text block to its natural height and clip overflow, so scrambled
// glyphs — often wider than the real letters — can never push a paragraph onto
// an extra line and shift everything below it (or spill past the card border).
// A 2-line definition stays exactly 2 lines; transient overflow is clipped, not
// shown, and the text is identical the moment the scramble resolves. We lock the
// innermost non-inline ancestor of each scrambleable text node (where the line
// box actually lives) and tag it so a resize can release and re-measure it.
function lockTextBlocks(card) {
  const seen = new Set();
  collectTextNodes(card).forEach((node) => {
    let el = node.parentElement;
    while (el && el !== card && getComputedStyle(el).display === "inline") {
      el = el.parentElement;
    }
    if (!el || el === card || seen.has(el)) return;
    seen.add(el);
    el.style.height = el.offsetHeight + "px";
    el.style.overflow = "hidden";
    el.dataset.lk = "1";
  });
}

// The entrance: each card flies up from below, blurred and tilted, overshoots
// its resting spot, then jiggles to a stop. Staggered so they cascade in.
function spawnCard(card, idx) {
  const delay = idx * STAGGER;

  card.animate(
    [
      { opacity: 0, filter: "blur(8px)", transform: "translateY(70px) scale(0.88) rotate(2.5deg)" },
      { opacity: 1, filter: "blur(0px)", offset: 0.32, transform: "translateY(-12px) scale(1.03) rotate(-1.2deg)" },
      { transform: "translateY(6px) scale(0.994) rotate(0.6deg)", offset: 0.6 },
      { transform: "translateY(-3px) scale(1.004) rotate(-0.25deg)", offset: 0.82 },
      { opacity: 1, filter: "blur(0px)", transform: "translateY(0) scale(1) rotate(0deg)" },
    ],
    {
      duration: 720,
      delay,
      easing: "cubic-bezier(0.16, 0.7, 0.3, 1)",
      fill: "backwards",
    }
  );
}

// --- Liquid-glass border: organic, biomimetic drift --------------------------
// Each card's gradient ring gets its own seed so no two move alike: a random
// direction, a wandering speed (a sum of slow incommensurate sines, so it
// drifts then surges then nearly stalls), and a position-based "catch" so it
// consistently slows and speeds at certain spots as it laps the border — like
// liquid pooling on the rounded corners. The bright band also breathes and the
// secondary highlight slides, so the ring morphs as it travels. One shared rAF
// loop drives every card; we don't spin up a callback per card.
const liquidItems = [];
let liquidRAF = null;
let liquidLast = 0;
const TAU = Math.PI * 2;

function registerLiquid(card) {
  liquidItems.push({
    el: card,
    dir: Math.random() < 0.5 ? 1 : -1,   // clockwise or counter, 50/50
    angle: Math.random() * 360,          // start anywhere on the ring
    baseSpeed: 15 + Math.random() * 21,  // deg/sec base (~24s..10s per lap)
    // Position "catch": consistent slow/fast zones tied to where the highlight
    // sits on the border. 1–2 lobes, random strength and offset per card.
    catchK: 1 + (Math.random() * 2 | 0),
    catchPhase: Math.random() * TAU,
    catchAmp: 0.4 + Math.random() * 0.4,
    // Time noise: two slow sines at incommensurate rates => speed wanders and
    // never quite repeats, occasionally surging or easing to a near-stall.
    t1f: 0.06 + Math.random() * 0.1, t1p: Math.random() * TAU,
    t2f: 0.13 + Math.random() * 0.16, t2p: Math.random() * TAU,
    timeAmp: 0.4 + Math.random() * 0.35,
    // Morph: independent breathing for band width and highlight slide.
    wf: 0.05 + Math.random() * 0.09, wp: Math.random() * TAU,
    sf: 0.04 + Math.random() * 0.08, sp: Math.random() * TAU,
    t: Math.random() * 1000,             // desync every card's noise phase
  });

  if (!liquidRAF) {
    liquidLast = performance.now();
    liquidRAF = requestAnimationFrame(liquidTick);
  }
}

function liquidTick(now) {
  let dt = (now - liquidLast) / 1000;
  liquidLast = now;
  if (dt > 0.1) dt = 0.1; // clamp big gaps (tab switch) so nothing lurches

  for (const it of liquidItems) {
    it.t += dt;
    const rad = (it.angle * Math.PI) / 180;
    // Where on the ring it currently is modulates speed (the "catch").
    const catchF = 1 + it.catchAmp * Math.sin(rad * it.catchK + it.catchPhase);
    // Slow wandering speed multiplier from layered sines.
    const noise =
      0.6 * Math.sin(it.t * it.t1f * TAU + it.t1p) +
      0.4 * Math.sin(it.t * it.t2f * TAU + it.t2p);
    const timeF = 1 + it.timeAmp * noise;
    // Keep it always advancing (never jarringly reverses), but allow a crawl.
    const speed = it.baseSpeed * Math.max(0.1, catchF) * Math.max(0.06, timeF);

    it.angle = (it.angle + it.dir * speed * dt) % 360;
    if (it.angle < 0) it.angle += 360;
    it.el.style.setProperty("--angle", it.angle.toFixed(2) + "deg");

    // Morph the ring as it travels: band width 0..1, highlight slide -1..1.
    const w = Math.sin(it.t * it.wf * TAU + it.wp) * 0.5 + 0.5;
    const s = Math.sin(it.t * it.sf * TAU + it.sp);
    it.el.style.setProperty("--lqW", w.toFixed(3));
    it.el.style.setProperty("--lqShift", s.toFixed(3));
  }

  liquidRAF = requestAnimationFrame(liquidTick);
}

// Matrix-style reveal: every piece of text in the card cycles random glyphs,
// then resolves left-to-right into the real characters. Nodes are staggered
// top-to-bottom so the whole card "rains" into legibility.
// A wide, mixed pool so the cycling reads as dense and alien. Every glyph must
// be a single UTF-16 code unit (randGlyph indexes by code unit) and stay roughly
// normal width, so no emoji/astral chars and no full-width CJK.
const GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + // Latin
  "ÆØÞßÐÑÇ" + // Latin extras
  "0123456789" + // digits
  "ΓΔΘΛΞΠΣΦΨΩαβγδεζηθλμξπσφχψω" + // Greek
  "БГДЖИЛФЦЧШЩЭЮЯ" + // Cyrillic
  "#%&@$+=*/\\<>~^?!|;:§±×÷°µ" + // symbols
  "∑∏∫√∞≈≠≤≥∂∆∇" + // math
  "¥£¢€¤©®™ø" + // currency & marks
  "ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ"; // half-width katakana
const randGlyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
const SCRAMBLE_CHAR = /[A-Za-z0-9]/; // cycle letters/digits; keep spaces & punctuation
const CASCADE = 950; // ms spread of the top-to-bottom resolve across a card
const NODE_DUR = 700; // ms for a single text node to resolve
const SWAP_MS = 55; // how often the random glyphs re-roll (higher = slower cycle)

// One shared rAF loop drives every active text node, across all cards, so we
// don't spin up hundreds of independent animation callbacks.
let scrambleItems = [];
let scrambleRAF = null;

// Build a glyph buffer: random glyphs for scrambleable chars, the real char
// (space/punctuation) everywhere else so word shapes stay intact.
function rollGlyphs(chars, into) {
  const out = into || new Array(chars.length);
  for (let i = 0; i < chars.length; i++) {
    out[i] = SCRAMBLE_CHAR.test(chars[i]) ? randGlyph() : chars[i];
  }
  return out;
}

function queueScramble(node, startDelay) {
  const finalText = node.nodeValue; // capture BEFORE we overwrite with glyphs
  const chars = [...finalText];
  const glyphs = rollGlyphs(chars);
  scrambleItems.push({
    node,
    chars,
    finalText,
    glyphs,
    start: performance.now() + startDelay,
    lastSwap: 0, // forces a roll on the first frame
  });
  // Scramble immediately so the very first paint shows cycling glyphs, not the
  // real text — otherwise there's a flash of the answer before the effect runs.
  node.nodeValue = glyphs.join("");
  if (!scrambleRAF) scrambleRAF = requestAnimationFrame(runScramble);
}

function runScramble(now) {
  for (let k = scrambleItems.length - 1; k >= 0; k--) {
    const it = scrambleItems[k];
    const t = (now - it.start) / NODE_DUR;
    if (t >= 1) {
      it.node.nodeValue = it.finalText; // settle on the real text
      scrambleItems.splice(k, 1);
      continue;
    }

    // Re-roll the random glyphs only every SWAP_MS, so the cycling reads as
    // tumbling letters rather than a per-frame blur. The reveal still advances
    // smoothly every frame.
    if (now - it.lastSwap >= SWAP_MS) {
      rollGlyphs(it.chars, it.glyphs);
      it.lastSwap = now;
    }

    const revealed = t > 0 ? Math.floor(t * it.chars.length) : 0;
    let out = "";
    for (let i = 0; i < it.chars.length; i++) {
      out += i < revealed ? it.chars[i] : it.glyphs[i];
    }
    it.node.nodeValue = out;
  }
  scrambleRAF = scrambleItems.length ? requestAnimationFrame(runScramble) : null;
}

// The card's visible text nodes — skipping whitespace-only nodes and link URLs.
// Shared by the intro scramble and the hover scramble so both target the same
// characters.
function collectTextNodes(card) {
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement.closest("a")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

// Queue each of a card's text nodes to resolve, staggered by vertical position.
function scrambleCard(card, baseDelay) {
  const nodes = collectTextNodes(card);

  nodes.forEach((node, i) => {
    const spread = nodes.length > 1 ? (i / (nodes.length - 1)) * CASCADE : 0;
    queueScramble(node, baseDelay + spread);
  });
}

// --- Hover scramble ----------------------------------------------------------
// Wherever the cursor moves over a card, characters within a small radius cycle
// random glyphs and the rest stay still — a little pool of turbulence trailing
// the pointer. We hit-test per character: each scrambleable char's on-screen
// center is measured once (via a one-char Range) and cached in document-space
// coords, so the test survives scrolling. Membership in the radius updates every
// frame (smooth following) while the glyph identities re-roll on a slower beat
// (so they tumble rather than strobe). One shared rAF loop covers all cards.
const HOVER_RADIUS = 62; // px around the cursor that gets scrambled
const HOVER_SWAP_MS = 60; // how often glyphs re-roll while fully heated
// Each character carries a "heat" (1 under the cursor, 0 at rest). When the
// cursor moves off it, heat decays to 0 over up to HOVER_DECAY_MS — and the
// re-roll thins out with the heat, so the tumbling slows more and more before
// the character finally locks to its real value. This unifies hover + linger:
// the wind-down happens wherever the cursor moves away, on every card.
const HOVER_DECAY_MS = 4000; // longest wind-down once a char leaves the radius
const HOVER_TWITCH_HEAT = 0.2; // below this heat a char flickers erratically...
const HOVER_TWITCH_CHANCE = 0.16; // ...at this per-swap chance (the last glitch)

let hoverNodes = []; // see registerHoverCard for the per-node shape
let hoverRAF = null;
let hoverActive = false; // pointer is currently inside the cards area
let hoverMeasured = false; // per-node bounding boxes have been measured
let hoverReadyAt = 0; // wait for the intro animation to settle before measuring
let hoverClientX = 0, hoverClientY = 0;
let hoverLastSwap = 0;
let hoverLastFrame = 0;

// Register a card's nodes for hover. Must run BEFORE the intro scramble, which
// overwrites nodeValue with glyphs — we need the real text as finalText here.
// Positions and per-char state are allocated lazily once the intro has settled.
function registerHoverCard(card) {
  collectTextNodes(card).forEach((node) => {
    hoverNodes.push({
      node,
      finalText: node.nodeValue,
      chars: [...node.nodeValue],
      centers: null, // [{x, y} | null] in document coords, measured lazily
      glyphs: null, // current random glyph per char (null = showing real char)
      heat: null, // per-char 0..1 heat
      decayK: null, // per-char decay rate (1/ms), staggered so locks fan out
      bbox: null, // {x0, y0, x1, y1} document-space, for a cheap reject
      hot: false, // any char currently heated (so the node shows glyphs)?
    });
  });
}

// One-char Range gives us the on-screen box of a single glyph. Stored in
// document coords (client + scroll) so the cache stays valid as the page scrolls.
function measureCenters(it) {
  if (it.node.nodeValue !== it.finalText) it.node.nodeValue = it.finalText;
  const range = document.createRange();
  const n = it.chars.length;
  const centers = new Array(n);
  const sx = window.scrollX, sy = window.scrollY;
  for (let i = 0; i < n; i++) {
    if (!SCRAMBLE_CHAR.test(it.chars[i])) { centers[i] = null; continue; }
    range.setStart(it.node, i);
    range.setEnd(it.node, i + 1);
    const r = range.getBoundingClientRect();
    centers[i] = r.width || r.height
      ? { x: r.left + sx + r.width / 2, y: r.top + sy + r.height / 2 }
      : null;
  }
  it.centers = centers;
  it.glyphs = new Array(n).fill(null);
  it.heat = new Array(n).fill(0);
  // Stagger each char's wind-down length. The squared random is heavy-tailed:
  // most characters resolve quickly (~1.3s) while a thin tail stretches toward
  // the full HOVER_DECAY_MS, so only one or two end up as the last stragglers.
  it.decayK = new Array(n);
  for (let i = 0; i < n; i++) {
    it.decayK[i] = 1 / (HOVER_DECAY_MS * (0.32 + 0.68 * Math.random() ** 2));
  }
}

// A coarse box per node (the whole text-node range) so most nodes are rejected
// with a couple of numeric compares before we ever touch per-character work.
function measureBBoxes() {
  const range = document.createRange();
  const sx = window.scrollX, sy = window.scrollY;
  for (const it of hoverNodes) {
    if (it.node.nodeValue !== it.finalText) it.node.nodeValue = it.finalText;
    range.selectNodeContents(it.node);
    const r = range.getBoundingClientRect();
    it.bbox = { x0: r.left + sx, y0: r.top + sy, x1: r.right + sx, y1: r.bottom + sy };
  }
  hoverMeasured = true;
}

function hoverTick() {
  hoverRAF = null;

  // Hold off until the intro animation (transforms + scramble) has settled, or
  // the measured positions would be wrong.
  const now = performance.now();
  if (now < hoverReadyAt) {
    if (hoverActive) hoverRAF = requestAnimationFrame(hoverTick);
    return;
  }
  if (!hoverMeasured) measureBBoxes();

  let dt = now - hoverLastFrame;
  hoverLastFrame = now;
  if (dt > 100) dt = 100; // clamp after a stall so heat doesn't lurch to 0

  const swap = now - hoverLastSwap >= HOVER_SWAP_MS;
  if (swap) hoverLastSwap = now;

  // Cursor in document coords; recomputed each frame so scrolling follows.
  const mx = hoverClientX + window.scrollX;
  const my = hoverClientY + window.scrollY;
  const r2 = HOVER_RADIUS * HOVER_RADIUS;

  let anyHot = false;

  for (const it of hoverNodes) {
    if (!it.node.isConnected) { it.hot = false; continue; }

    // Is the cursor near this node's box this frame?
    let near = false;
    if (hoverActive) {
      const b = it.bbox;
      near = !(
        mx < b.x0 - HOVER_RADIUS || mx > b.x1 + HOVER_RADIUS ||
        my < b.y0 - HOVER_RADIUS || my > b.y1 + HOVER_RADIUS
      );
    }
    // Skip nodes the cursor isn't near that also have no heat left to cool.
    if (!near && !it.hot) continue;

    if (!it.centers) measureCenters(it);

    let out = "";
    let nodeHot = false;
    for (let i = 0; i < it.chars.length; i++) {
      const c = it.centers[i];
      let h = it.heat[i];

      let inR = false;
      if (near && c) {
        const dx = c.x - mx, dy = c.y - my;
        inR = dx * dx + dy * dy <= r2;
      }
      if (inR) h = 1; // under the cursor: fully scrambled
      else if (h > 0) h = Math.max(0, h - dt * it.decayK[i]); // winding down
      it.heat[i] = h;

      if (h > 0 && c) {
        // Re-roll probability scales with heat: brisk when hot, sparse as it
        // cools, so the tumbling visibly slows. Below HOVER_TWITCH_HEAT it stops
        // slowing and instead flickers erratically — the last stragglers throw a
        // few twitchy glitches right before locking.
        let roll = it.glyphs[i] === null;
        if (!roll && swap) {
          roll = h > HOVER_TWITCH_HEAT
            ? Math.random() < h
            : Math.random() < HOVER_TWITCH_CHANCE;
        }
        if (roll) it.glyphs[i] = randGlyph();
        out += it.glyphs[i];
        nodeHot = true;
      } else {
        it.glyphs[i] = null;
        out += it.chars[i];
      }
    }

    if (nodeHot) { it.node.nodeValue = out; it.hot = true; anyHot = true; }
    else if (it.hot) { it.node.nodeValue = it.finalText; it.hot = false; }
  }

  // Keep ticking while the cursor is engaged or anything is still cooling.
  if (hoverActive || anyHot) hoverRAF = requestAnimationFrame(hoverTick);
}

function startHover() {
  hoverActive = true;
  if (!hoverRAF) {
    hoverLastFrame = performance.now();
    hoverRAF = requestAnimationFrame(hoverTick);
  }
}

els.cards.addEventListener("pointermove", (e) => {
  hoverClientX = e.clientX;
  hoverClientY = e.clientY;
  startHover();
});
// Pointer left: just drop the cursor. The loop keeps running on its own,
// cooling every heated character to its real value, then stops.
els.cards.addEventListener("pointerleave", () => { hoverActive = false; });
// A resize reflows everything, so the cached positions are stale — reset and
// re-measure, restoring any text that was mid-scramble.
window.addEventListener("resize", () => {
  hoverMeasured = false;
  for (const it of hoverNodes) {
    if (it.hot) it.node.nodeValue = it.finalText;
    it.centers = it.bbox = it.heat = it.glyphs = it.decayK = null;
    it.hot = false;
  }
  // Locked geometry was taken at the old width; release every locked box, let
  // the cards reflow to the new width, then re-lock to the fresh natural sizes.
  const cards = [...els.cards.querySelectorAll(".result")];
  cards.forEach((card) => {
    card.style.height = "";
    card.querySelectorAll("[data-lk]").forEach((el) => {
      el.style.height = "";
      el.style.overflow = "";
      delete el.dataset.lk;
    });
  });
  cards.forEach((card) => {
    card.style.height = card.offsetHeight + "px";
    lockTextBlocks(card);
  });
});

// --- Events ------------------------------------------------------------------
// Read the count input, clamped to the supported 1–10 range.
function clampCount() {
  const raw = parseInt(els.countInput.value, 10);
  if (Number.isNaN(raw)) return 1;
  return Math.min(10, Math.max(1, raw));
}

async function newWords() {
  if (busy || !words.length) return;
  busy = true;
  els.btn.disabled = true;
  els.cards.innerHTML = "";
  els.status.classList.remove("error");

  const n = clampCount();
  els.status.textContent = n === 1 ? "Finding a word…" : `Finding ${n} words…`;

  // Fetch all requested words at once; each resolves to a model or null.
  const results = await Promise.all(
    Array.from({ length: n }, () => fetchDefinedWord())
  );

  const models = results.filter(Boolean);
  const found = models.length;
  if (found) layoutCards(models);

  if (!found) {
    els.status.classList.add("error");
    els.status.textContent =
      `Gave up after ${MAX_TRIES} tries each — none of the random words were in any dictionary. Try again.`;
  } else if (found < n) {
    els.status.textContent = `Showing ${found} of ${n} — the rest weren't in any dictionary.`;
  } else {
    els.status.textContent = "";
  }

  busy = false;
  els.btn.disabled = false;
}

// Keep the button label honest about how many cards it'll grab.
function syncBtnLabel() {
  els.btn.textContent = clampCount() === 1 ? "New Word" : "New Words";
}

els.btn.addEventListener("click", newWords);
els.countInput.addEventListener("input", syncBtnLabel);

loadWords();
