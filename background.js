/**
 * Pulse Price Scanner — background service worker.
 *
 * The one place that talks to the pokemon-price-checker service (the wrapper
 * around PokePulse). Content scripts NEVER call the API directly — they post a
 * listing title here and get back a priced result. Centralising it lets us:
 *   - keep a single client-side cache (the server caches 6h too, but this
 *     avoids even the round-trip for repeats),
 *   - bound concurrency so a 50-item search page can't fan out 50 lookups,
 *   - dedupe identical in-flight queries.
 *
 * Two upstream endpoints (both public / no-auth on the price-checker):
 *   GET /api/search?name=&num=   → candidate cards (cheap, public PokePulse search)
 *   GET /api/lookup?code=setId-num → priced variants (partner API, ~1000/day cap)
 */

// Hardcoded backend — NOT user-configurable; there is no URL field in the UI.
// (A browser extension is client-side, so a determined user can still read this
// from the unpacked files or the network tab. This keeps it out of the UI and
// out of editable settings, which is as private as a client extension allows.)
const SERVICE_URL = 'https://instore.pulsecollective.co.uk';

const DEFAULTS = {
  enabled: true,
  sites: { ebay: true, vinted: true, facebook: true },
};

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // mirror the server's PRICE_TTL_MS
const NEG_TTL_MS = 30 * 60 * 1000;       // remember "no match" for 30m so we don't re-hammer
const MAX_CONCURRENT = 4;

// ---------- settings ----------
async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored, sites: { ...DEFAULTS.sites, ...(stored.sites || {}) } };
}

// ---------- auth (access code) ----------
// The validated code is stored locally and sent as X-Access-Code on every
// pricing request. No code → the extension stays locked and prices nothing.
async function getAuth() {
  const { auth } = await chrome.storage.local.get('auth');
  return auth || {};
}
async function setAuth(a) { await chrome.storage.local.set({ auth: a }); }
async function clearAuth() { await chrome.storage.local.remove('auth'); }

// ---------- title parsing ----------
// Marketplace titles are free text ("Charizard ex 199/165 Pokemon 151 PSA 10").
// Pull out a best-effort (name, num, grade); the server's fuzzy search does the
// rest of the heavy lifting, so we only need to be roughly right.
const NOISE = /\b(pokemon|pokémon|tcg|ccg|card|cards|single|singles|near\s*mint|mint|nm|lp|mp|hp|graded|ungraded|gem|holo|reverse|foil|japanese|japan|english|sealed|genuine|authentic|official|ultra|rare|the|lot|x1|brand\s*new)\b/ig;

function parseTitle(raw) {
  if (!raw) return { name: '', num: '', grade: '' };
  const t = ' ' + String(raw).replace(/\s+/g, ' ').trim() + ' ';

  let grade = '';
  const gm = t.match(/\b(PSA|CGC|BGS|SGC|ACE|TAG)\s*\.?\s*(10|9\.5|9|8\.5|8|7\.5|7|6|5)\b/i);
  if (gm) grade = gm[2];

  let num = '';
  let numIdx = -1;
  const frac = t.match(/\b(\d{1,3})\s*\/\s*\d{1,3}[a-z]?\b/i);
  if (frac) { num = frac[1]; numIdx = frac.index; }
  if (!num) {
    // Set-prefixed codes: TG12, GG44, RC29, SWSH123, SVP068, H12 …
    const alnum = t.match(/\b([A-Za-z]{1,4}\d{1,3}[a-z]?)\b/);
    if (alnum && !/^(psa|cgc|bgs|sgc|no|lot)\d/i.test(alnum[1])) {
      num = alnum[1]; numIdx = alnum.index;
    }
  }
  if (!num) {
    const hash = t.match(/#\s*(\d{1,3})\b/);
    if (hash) { num = hash[1]; numIdx = hash.index; }
  }

  let namePart = numIdx >= 0 ? t.slice(0, numIdx) : t;
  namePart = namePart
    .replace(/\b(PSA|CGC|BGS|SGC|ACE|TAG)\s*\.?\s*\d+(\.\d)?\b/ig, ' ')
    .replace(NOISE, ' ')
    .replace(/[^A-Za-z0-9'.\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let name = namePart.split(' ').filter(Boolean).slice(0, 5).join(' ').trim();
  if (!name) {
    // Fall back to the cleaned whole title if everything landed after the number.
    name = t.replace(NOISE, ' ').replace(/[^A-Za-z0-9'.\- ]/g, ' ')
      .replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
  }

  // Stated ungraded condition, if the listing mentions one. Check specific
  // phrases before the generic "played"; "ex"/"gx"/"v" are card types so they
  // are deliberately NOT treated as conditions.
  return { name, num, grade, condition: detectCondition(t) };
}

// Map free text (a listing title OR eBay's structured Condition field) to a TCG
// condition key. Specific phrases are checked before the generic "played";
// card-type tokens ("ex"/"gx"/"v") are intentionally NOT treated as conditions.
function detectCondition(text) {
  const lc = ' ' + String(text || '').toLowerCase() + ' ';
  if (/heavily played|heavy play|\bhp\b|\bdmg\b|damaged|\bpoor\b/.test(lc)) return 'hp';
  if (/lightly played|light play|\blp\b/.test(lc)) return 'lp';
  if (/moderately played|moderate play|\bmp\b/.test(lc)) return 'mp';
  if (/\bplayed\b|\bpl\b/.test(lc)) return 'mp';
  if (/near[\s-]?mint|\bnm\b|\bmint\b/.test(lc)) return 'nm';
  return '';
}

function leadInt(s) {
  const m = String(s || '').split('/')[0].match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}
function sameNum(cardNumber, num) {
  const a = leadInt(cardNumber), b = leadInt(num);
  if (!Number.isNaN(a) && !Number.isNaN(b)) return a === b;
  return String(cardNumber || '').toLowerCase().replace(/\s/g, '')
    .startsWith(String(num || '').toLowerCase().replace(/\s/g, ''));
}

// ---------- currency ----------
const SYMBOLS = { GBP: '£', USD: '$', EUR: '€', JPY: '¥', CAD: 'CA$', AUD: 'A$' };
function fmtMoney(value, currency) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const cur = currency || '£';
  const sym = SYMBOLS[cur] || (cur.length <= 2 ? cur : '');
  const body = n >= 100 ? n.toFixed(0) : n.toFixed(2);
  return sym ? `${sym}${body}` : `${body} ${cur}`;
}

// ---------- cache ----------
// Keyed by card identity only (name+num) — NOT by condition/grade, because the
// cached payload is the raw NM/LP/MP/HP + graded data. The per-listing headline
// (which depends on the listing's stated condition) is computed after the fetch.
// Bump the version prefix whenever the cached shape changes, to drop stale entries.
function cacheKey(p) { return `v2|${p.name.toLowerCase()}|${p.num.toLowerCase()}`; }

async function cacheGet(key) {
  const all = await chrome.storage.local.get(key);
  const hit = all[key];
  if (!hit) return null;
  const ttl = hit.data?.ok ? CACHE_TTL_MS : NEG_TTL_MS;
  if (Date.now() - hit.ts > ttl) return null;
  return hit.data;
}
async function cacheSet(key, data) {
  await chrome.storage.local.set({ [key]: { ts: Date.now(), data } });
}

// ---------- concurrency ----------
let active = 0;
const queue = [];
function schedule(fn) {
  return new Promise((resolve) => {
    const run = async () => {
      active++;
      try { resolve(await fn()); }
      finally { active--; if (queue.length) queue.shift()(); }
    };
    if (active < MAX_CONCURRENT) run(); else queue.push(run);
  });
}

const inflight = new Map(); // key -> Promise (dedupe identical concurrent queries)

// ---------- API ----------
async function apiGet(base, path, headers) {
  const res = await fetch(base + path, { headers: { Accept: 'application/json', ...(headers || {}) } });
  if (!res.ok) { const e = new Error(`${res.status} ${path}`); e.status = res.status; throw e; }
  return res.json();
}

// Fetch the condition-agnostic card data (cacheable): the matched card plus its
// raw NM/LP/MP/HP and graded prices. No headline is chosen here.
async function fetchCardData(base, parsed, accessCode) {
  const h = accessCode ? { 'X-Access-Code': accessCode } : null;
  const search = await apiGet(base, `/api/search?name=${encodeURIComponent(parsed.name)}${parsed.num ? `&num=${encodeURIComponent(parsed.num)}` : ''}`, h);
  const results = Array.isArray(search.results) ? search.results : [];
  if (!results.length) return { ok: false, reason: 'no_match' };

  let best = null;
  if (parsed.num) best = results.find(r => sameNum(r.card_number, parsed.num));
  if (!best) best = results[0];

  const code = `${best.set_id}-${best.card_number}`;
  const match = {
    code,
    setId: best.set_id,
    cardNumber: best.card_number,
    name: best.name,
    setName: best.set_name || best.set_code || best.set_id,
    imageUrl: best.image_url || null,
  };

  const lookup = await apiGet(base, `/api/lookup?code=${encodeURIComponent(code)}`, h);
  const variants = Array.isArray(lookup.variants) ? lookup.variants : [];
  if (!variants.length) return { ok: false, reason: 'no_price', match };

  const conditions = {};
  let currency = null;
  const ungraded = variants.find(v => !v.gradingCo && v.price && v.price.conditions);
  if (ungraded) {
    currency = ungraded.price.currency || null;
    for (const [k, v] of Object.entries(ungraded.price.conditions)) {
      const n = parseFloat(v);
      if (Number.isFinite(n) && n > 0) conditions[k.toLowerCase()] = n;
    }
  }
  const graded = variants
    .filter(v => v.gradingCo && v.price && Number(v.price.value) > 0)
    .map(v => ({ company: v.gradingCo, grade: String(v.grade ?? ''), value: Number(v.price.value), currency: v.price.currency }))
    .sort((a, b) => b.value - a.value);

  if (!Object.keys(conditions).length && !graded.length) return { ok: false, reason: 'no_price', match };
  return { ok: true, match, conditions, currency, graded };
}

// Choose what the badge shows, per listing, from cached card data:
//   graded title  → that graded price
//   stated cond   → that condition's price (labelled + colour-coded)
//   otherwise     → the market price (NM/best), shown with NO label
function selectHeadline(card, parsed) {
  const conditions = card.conditions || {};
  const graded = card.graded || [];
  const ungradedCur = card.currency;
  let value = null, currency = null, label = '', cond = null, stated = false;

  if (parsed.grade) {
    const g = graded.find(x => x.grade === parsed.grade) || graded[0];
    if (g) { value = g.value; currency = g.currency; label = `${g.company} ${g.grade}`.trim(); stated = true; }
  }
  if (value == null && parsed.condition && conditions[parsed.condition] != null) {
    value = conditions[parsed.condition];
    currency = ungradedCur;
    cond = parsed.condition;
    label = parsed.condition.toUpperCase();
    stated = true;
  }
  if (value == null) {
    const usedKey = ['nm', 'lp', 'mp', 'hp'].find(k => conditions[k] != null) || null;
    if (usedKey) { value = conditions[usedKey]; currency = ungradedCur; cond = usedKey; }
    label = '';
  }

  if (value == null) return { ok: false, reason: 'no_price', match: card.match };
  return {
    ok: true,
    query: parsed,
    match: card.match,
    headline: { value, currency, label, cond, stated, text: fmtMoney(value, currency) },
    conditions,
    graded: graded.slice(0, 3),
  };
}

async function priceCard(title, conditionText) {
  const base = SERVICE_URL;

  // Gate: no validated access code → locked, price nothing.
  const auth = await getAuth();
  if (!auth.code) return { ok: false, reason: 'locked' };

  const parsed = parseTitle(title);
  if (!parsed.name || parsed.name.length < 2) return { ok: false, reason: 'parse_failed', query: parsed };

  // An explicit condition (e.g. eBay's structured Condition field) overrides
  // whatever was parsed from the title.
  if (conditionText) {
    const c = detectCondition(conditionText);
    if (c) parsed.condition = c;
  }

  const key = cacheKey(parsed);
  let card = await cacheGet(key);
  let source = 'cache';

  if (!card) {
    source = 'live';
    if (inflight.has(key)) {
      card = await inflight.get(key);
    } else {
      const job = schedule(async () => {
        try {
          const data = await fetchCardData(base, parsed, auth.code);
          await cacheSet(key, data);
          return data;
        } catch (err) {
          // Code revoked/expired server-side → drop it and report locked.
          if (err.status === 401) { await clearAuth(); return { ok: false, reason: 'locked' }; }
          return { ok: false, reason: 'error', message: String(err.message || err) };
        } finally {
          inflight.delete(key);
        }
      });
      inflight.set(key, job);
      card = await job;
    }
  }

  if (!card || !card.ok) return { ...(card || { ok: false, reason: 'error' }), query: parsed, source };
  // Headline is recomputed every call, so the SAME cached card renders the right
  // price/colour for each listing's own stated condition.
  return { ...selectHeadline(card, parsed), source };
}

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'PRICE') {
    priceCard(msg.title, msg.conditionText).then(sendResponse);
    return true;
  }
  if (msg?.type === 'GET_SETTINGS') {
    getSettings().then(sendResponse);
    return true;
  }
  if (msg?.type === 'GET_AUTH') {
    getAuth().then(a => sendResponse({ signedIn: !!a.code, label: a.label || null }));
    return true;
  }
  if (msg?.type === 'SIGN_IN') {
    (async () => {
      const code = String(msg.code || '').trim().toUpperCase();
      if (!code) return sendResponse({ ok: false, error: 'Enter your access code.' });
      try {
        // Code goes in the BODY (not the X-Access-Code header) so the gate
        // middleware doesn't reject it before /api/access/validate runs.
        const res = await fetch(SERVICE_URL + '/api/access/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ code }),
        });
        if (res.ok) {
          const data = await res.json();
          await setAuth({ code, label: data.label || null });
          sendResponse({ ok: true, label: data.label || null });
        } else if (res.status === 401) {
          sendResponse({ ok: false, error: 'Invalid or revoked code.' });
        } else {
          sendResponse({ ok: false, error: `Server error (${res.status}).` });
        }
      } catch {
        sendResponse({ ok: false, error: 'Could not reach the service.' });
      }
    })();
    return true;
  }
  if (msg?.type === 'SIGN_OUT') {
    clearAuth().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'SET_SETTINGS') {
    chrome.storage.sync.set(msg.settings).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'GET_USAGE') {
    (async () => {
      const base = SERVICE_URL;
      try {
        // /health is public (kiosk allowlist); the real reachability probe.
        await apiGet(base, '/health');
      } catch (err) {
        return sendResponse({ ok: false, reason: 'unreachable', message: String(err.message || err) });
      }
      // /api/usage sits behind the dashboard's Basic Auth and the extension has
      // no credentials, so counters are best-effort — absence isn't a failure.
      let usage = null;
      try { usage = await apiGet(base, '/api/usage'); } catch { /* gated — ignore */ }
      sendResponse({ ok: true, usage, base });
    })();
    return true;
  }
  if (msg?.type === 'CLEAR_CACHE') {
    chrome.storage.local.clear().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// ---------- context menu: price any selected text on any page ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'pulse-price-selection',
    title: 'Pulse: price “%s”',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'pulse-price-selection' || !tab?.id) return;
  const result = await priceCard(info.selectionText || '');
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showOverlay,
      args: [result],
    });
  } catch (err) {
    console.warn('[pulse] overlay inject failed', err);
  }
});

// Injected into the active tab to render a one-off floating result card.
// Self-contained (no imports / styles): runs in the page world via executeScript.
function showOverlay(result) {
  const ID = 'pulse-price-overlay';
  document.getElementById(ID)?.remove();
  const box = document.createElement('div');
  box.id = ID;
  Object.assign(box.style, {
    position: 'fixed', top: '16px', right: '16px', zIndex: 2147483647,
    width: '260px', padding: '12px 14px', background: '#11141a', color: '#e8eaed',
    font: '13px/1.4 system-ui, sans-serif', borderRadius: '12px',
    boxShadow: '0 8px 30px rgba(0,0,0,.45)', border: '1px solid #2a2f3a',
  });
  const money = (v, c) => {
    const sym = { GBP: '£', USD: '$', EUR: '€', JPY: '¥' }[c] || (c && c.length <= 2 ? c : '');
    return v == null ? '—' : (sym ? sym + (+v).toFixed(2) : (+v).toFixed(2) + ' ' + (c || ''));
  };
  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
    + '<strong style="color:#7cc4ff">Pulse market value</strong>'
    + '<span style="cursor:pointer;opacity:.6" id="pulse-x">✕</span></div>';
  if (result?.ok) {
    const m = result.match || {};
    html += `<div style="font-weight:600">${result.headline.text} <span style="opacity:.6;font-weight:400">${result.headline.label}</span></div>`;
    html += `<div style="opacity:.75;margin-top:2px">${m.name || ''} · ${m.setName || ''} ${m.cardNumber ? '#' + m.cardNumber : ''}</div>`;
    const c = result.conditions || {};
    const conds = ['nm', 'lp', 'mp', 'hp'].filter(k => c[k] != null)
      .map(k => `${k.toUpperCase()} ${money(c[k], result.headline.currency)}`).join('  ');
    if (conds) html += `<div style="opacity:.6;margin-top:6px;font-size:12px">${conds}</div>`;
    if (result.graded?.length) {
      html += '<div style="opacity:.6;margin-top:4px;font-size:12px">'
        + result.graded.map(g => `${g.company} ${g.grade}: ${money(g.value, g.currency)}`).join('  ') + '</div>';
    }
  } else {
    const reasons = {
      no_match: 'No matching card found', no_price: 'Card found, no price data',
      parse_failed: 'Could not read a card from the text',
      locked: 'Sign in: open the Pulse extension and enter your access code',
      error: 'Lookup failed',
    };
    html += `<div style="opacity:.8">${reasons[result?.reason] || 'No result'}</div>`;
    if (result?.message) html += `<div style="opacity:.5;margin-top:4px;font-size:11px">${result.message}</div>`;
  }
  box.innerHTML = html;
  document.body.appendChild(box);
  box.querySelector('#pulse-x').onclick = () => box.remove();
  setTimeout(() => box.remove(), 12000);
}
