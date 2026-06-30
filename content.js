/**
 * Pulse Price Scanner — content script (eBay / Vinted / Facebook Marketplace).
 *
 * Finds card listings on the page, and for each one that scrolls into view asks
 * the background worker for a market value, then injects an inline badge. Pricing
 * is lazy (IntersectionObserver) on purpose: the upstream /api/lookup has a
 * ~1000/day cap, so we only spend a lookup on listings the user actually sees.
 */
(() => {
  if (window.__pulseScannerLoaded) return;
  window.__pulseScannerLoaded = true;

  const host = location.hostname;

  // ---------- site adapters ----------
  // Each adapter returns listing descriptors: { el, title, mount }.
  //   el    — the listing root (used to dedupe + observe).
  //   title — free text we hand to the parser.
  //   mount — element the badge is appended to.
  const adapters = {
    ebay: {
      test: () => /(^|\.)ebay\./.test(host),
      items() {
        // Single item page.
        if (/\/itm\//.test(location.pathname)) {
          const titleEl = document.querySelector('h1 .x-item-title__mainTitle, #itemTitle, .x-item-title__mainTitle');
          if (!titleEl) return [];
          const mount = document.querySelector('.x-price-primary, .x-bin-price__content, #CenterPanelInternal') || titleEl;
          // eBay's structured Condition field (sellers pick "Near Mint",
          // "Lightly Played", "Damaged", etc. for TCG). Take just the condition
          // value text and drop the "Read more…" trailer so the parser doesn't
          // see eBay's disclaimer copy.
          const condEl = document.querySelector(
            '.x-item-condition-text .ux-textspans, .x-item-condition-value .ux-textspans, .x-item-condition-text, [data-testid="x-item-condition"]'
          );
          const condition = condEl
            ? (condEl.textContent || '').split('\n')[0].replace(/read more.*/i, '').trim().slice(0, 60)
            : '';
          return [{ el: mount, title: text(titleEl), mount, condition }];
        }
        // Search / browse grid.
        const cards = qa('li.s-item, li.s-card, .srp-results .s-item, .brwrvr__item-card');
        const out = [];
        for (const el of cards) {
          const titleEl = el.querySelector('.s-item__title, .s-card__title, .bsig__title, [role="heading"]');
          const title = text(titleEl);
          if (!title || /shop on ebay/i.test(title)) continue;
          const mount = el.querySelector('.s-item__detail--primary, .s-item__info, .s-card__attribute-row, .s-item__subtitle') || el;
          // Grid subtitle sometimes carries the condition (often "Pre-Owned" /
          // "Brand New", which simply won't match a TCG grade — harmless).
          const condition = text(el.querySelector('.s-item__subtitle, .s-card__subtitle'));
          out.push({ el, title, mount, condition });
        }
        return out;
      },
    },

    vinted: {
      test: () => /(^|\.)vinted\./.test(host),
      items() {
        // Single item page.
        if (document.querySelector('[data-testid="item-page-summary-plugin"], .item-page')) {
          const titleEl = document.querySelector('[data-testid="item-page-summary-plugin"] [itemprop="name"], h1, .item-page-title');
          const title = text(titleEl) || document.title;
          const mount = document.querySelector('[data-testid="item-page-summary-plugin"]') || titleEl || document.body;
          if (title) return [{ el: mount, title, mount }];
          return [];
        }
        // Catalog grid — anchors to /items/, deduped by their containing box.
        const seen = new Set();
        const out = [];
        for (const a of qa('a[href*="/items/"]')) {
          const box = a.closest('.feed-grid__item, .new-item-box__container, li, .catalog-grid__item') || a;
          if (seen.has(box)) continue;
          seen.add(box);
          const title = a.getAttribute('title') || a.getAttribute('aria-label') || text(box);
          if (!title || title.length < 4) continue;
          const mount = box.querySelector('.new-item-box__description, .new-item-box__title') || box;
          out.push({ el: box, title, mount });
        }
        return out;
      },
    },

    facebook: {
      test: () => /(^|\.)facebook\.com$/.test(host),
      enabled: () => /\/marketplace/.test(location.pathname),
      items() {
        if (!/\/marketplace/.test(location.pathname)) return [];
        const out = [];
        for (const a of qa('a[href*="/marketplace/item/"]')) {
          // Pick the longest non-price text span as the title; price spans carry a currency symbol.
          const spans = qa('span', a).map(text).filter(Boolean);
          const title = spans
            .filter(s => !/^[£$€¥]/.test(s.trim()) && s.length > 6)
            .sort((x, y) => y.length - x.length)[0];
          if (!title) continue;
          out.push({ el: a, title, mount: a });
        }
        return out;
      },
    },
  };

  function qa(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function text(el) { return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }

  const DBG = false; // flip to true to surface the [pulse] console logs while debugging
  const log = (...a) => DBG && console.log('%c[pulse]', 'color:#2ea4ff;font-weight:700', ...a);

  const siteKey = Object.keys(adapters).find(k => adapters[k].test());
  log('content script loaded · site =', siteKey || 'NONE', '·', location.href);
  if (!siteKey) return;
  const adapter = adapters[siteKey];

  // ---------- settings gate ----------
  let settings = null;
  let signedIn = false;
  async function loadSettings() {
    settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).catch(() => null);
    return settings;
  }
  async function refreshAuth() {
    const a = await chrome.runtime.sendMessage({ type: 'GET_AUTH' }).catch(() => null);
    signedIn = !!(a && a.signedIn);
    return signedIn;
  }
  function active() {
    return signedIn && settings && settings.enabled && settings.sites?.[siteKey] !== false
      && (!adapter.enabled || adapter.enabled());
  }

  // One-time, non-blocking notice when the user isn't signed in.
  function showLockToast() {
    if (document.getElementById('pulse-locked-toast')) return;
    const t = document.createElement('div');
    t.id = 'pulse-locked-toast';
    t.className = 'pulse-toast';
    t.textContent = '🔒 Sign in to Pulse (click the extension icon) to see card prices';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 8000);
  }

  // ---------- badge ----------
  function makeBadge() {
    const b = document.createElement('span');
    b.className = 'pulse-badge pulse-loading';
    b.textContent = 'pricing…';
    return b;
  }

  function paint(badge, result) {
    badge.classList.remove('pulse-loading');
    if (result?.ok) {
      const h = result.headline;
      // Default shows just the market price (no label). When the listing states
      // a condition, the label appears and the pill colours by that condition:
      // NM=blue, LP=green, MP=amber, HP=red (graded/unknown → blue).
      const cond = { nm: 'pulse-cond-nm', lp: 'pulse-cond-lp', mp: 'pulse-cond-mp', hp: 'pulse-cond-hp' }[h.cond] || 'pulse-cond-nm';
      badge.classList.add('pulse-ok', cond);
      badge.innerHTML = `<b>${h.text}</b>` + (h.label ? `<span class="pulse-lbl">${esc(h.label)}</span>` : '');
      badge.removeAttribute('title'); // the custom popover replaces the native tooltip
      badge.addEventListener('mouseenter', () => showPopover(badge, result));
      badge.addEventListener('mouseleave', hidePopoverSoon);
    } else {
      badge.classList.add('pulse-miss');
      if (result?.reason === 'locked') {
        badge.textContent = '🔒 Sign in to Pulse';
        badge.title = 'Open the Pulse extension and enter your access code';
      } else {
        const labels = { no_match: 'no match', no_price: 'no price', parse_failed: '—', error: 'error' };
        badge.textContent = `Pulse: ${labels[result?.reason] || '—'}`;
        if (result?.message) badge.title = result.message;
      }
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  // Hover popover: one shared element, repositioned/repopulated per badge.
  // Appended to <body> (position:fixed) so listing cards with overflow:hidden
  // can't clip it. Text-only by design — clean breakdown, no image.
  let popEl = null, popTimer = null;
  function ensurePopover() {
    if (popEl) return popEl;
    popEl = document.createElement('div');
    popEl.className = 'pulse-pop';
    popEl.style.display = 'none';
    popEl.addEventListener('mouseenter', () => { popEl._over = true; });
    popEl.addEventListener('mouseleave', () => { popEl._over = false; hidePopoverSoon(); });
    document.body.appendChild(popEl);
    return popEl;
  }
  function popoverHtml(result) {
    const m = result.match || {}, c = result.conditions || {}, cur = result.headline.currency;
    const active = String(result.headline.cond || '').toLowerCase();
    const rows = [['NM', 'nm'], ['LP', 'lp'], ['MP', 'mp'], ['HP', 'hp']]
      .filter(([, k]) => c[k] != null)
      .map(([lbl, k]) => `<div class="pulse-pop-row pulse-c-${k}${k === active ? ' pulse-pop-active' : ''}"><span>${lbl}</span><b>${money(c[k], cur)}</b></div>`).join('');
    const graded = (result.graded || [])
      .map(g => `<div class="pulse-pop-row pulse-pop-g"><span>${esc(g.company)} ${esc(g.grade)}</span><b>${money(g.value, g.currency)}</b></div>`).join('');
    return `<div class="pulse-pop-name"><b>${esc(m.name)}</b>`
      + `<span>${esc(m.setName)}${m.cardNumber ? ' · #' + esc(m.cardNumber) : ''}</span></div>`
      + (rows ? `<div class="pulse-pop-sec">Ungraded</div>${rows}` : '')
      + (graded ? `<div class="pulse-pop-sec">Graded</div>${graded}` : '');
  }
  function showPopover(badge, result) {
    clearTimeout(popTimer);
    const el = ensurePopover();
    el.innerHTML = popoverHtml(result);
    el.style.display = 'block';
    const r = badge.getBoundingClientRect();
    const pw = el.offsetWidth, ph = el.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - pw - 8);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = r.top - ph - 6; // flip above if no room below
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = Math.max(8, top) + 'px';
  }
  function hidePopoverSoon() {
    clearTimeout(popTimer);
    popTimer = setTimeout(() => { if (popEl && !popEl._over) popEl.style.display = 'none'; }, 140);
  }

  function money(v, c) {
    const sym = { GBP: '£', USD: '$', EUR: '€', JPY: '¥' }[c] || (c && c.length <= 2 ? c : '');
    return v == null ? '—' : (sym ? sym + (+v).toFixed(2) : (+v).toFixed(2) + ' ' + (c || ''));
  }

  // ---------- engine ----------
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      process(e.target);
    }
  }, { rootMargin: '300px' });

  function process(el) {
    const item = el.__pulseItem;
    if (!item || el.__pulsePriced) return;
    el.__pulsePriced = true;

    const badge = makeBadge();
    try { item.mount.appendChild(badge); }
    catch { (el.appendChild ? el : document.body).appendChild(badge); }

    log('price →', JSON.stringify(item.title).slice(0, 80));
    chrome.runtime.sendMessage({ type: 'PRICE', title: item.title, conditionText: item.condition || '' })
      .then((result) => {
        // Locked mid-session (code revoked, or never signed in) — stop scanning
        // and nudge the user once, rather than painting "locked" on every card.
        if (result?.reason === 'locked') { signedIn = false; observer.disconnect(); mo.disconnect(); showLockToast(); }
        log('price ←', result?.ok ? result.headline?.text + ' ' + result.headline?.label : 'miss:' + result?.reason, '·', item.title.slice(0, 50));
        paint(badge, result);
      })
      .catch((err) => { log('price ✕', err); badge.classList.remove('pulse-loading'); badge.classList.add('pulse-miss'); badge.textContent = 'Pulse: error'; badge.title = String(err); });
  }

  function scan(force) {
    if (!active()) { log('scan skipped · active =', !!active(), '· settings =', settings); return; }
    let items;
    try { items = adapter.items(); } catch (err) { log('adapter.items() threw:', err); return; }
    const fresh = items.filter(i => i.el && !i.el.__pulseSeen).length;
    log(`scan · site=${siteKey} · items found=${items.length} · new=${fresh} · force=${!!force}`);
    for (const item of items) {
      const el = item.el;
      if (!el || el.__pulseSeen) continue;
      el.__pulseSeen = true;
      el.__pulseItem = item;
      if (force) process(el);
      else observer.observe(el);
    }
  }

  // Re-scan on DOM mutations (infinite scroll, SPA re-render) — debounced.
  let timer = null;
  function debouncedScan() { clearTimeout(timer); timer = setTimeout(() => scan(false), 500); }
  const mo = new MutationObserver(debouncedScan);

  // SPA navigations don't reload the page; watch the URL and reset.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => scan(false), 800);
    }
  }, 1000);

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg?.type === 'RESCAN') {
      (async () => {
        await loadSettings();
        await refreshAuth();
        if (signedIn) { mo.observe(document.body, { childList: true, subtree: true }); scan(true); }
        send?.({ ok: true });
      })();
      return true;
    }
    if (msg?.type === 'SETTINGS_CHANGED') {
      loadSettings().then(() => scan(false));
    }
    return false;
  });

  (async () => {
    await loadSettings();
    await refreshAuth();
    if (!signedIn) { showLockToast(); return; } // locked → no scanning until signed in
    scan(false);
    // SPA listings (Vinted/FB) often render after document_idle — re-scan a few
    // times as insurance on top of the MutationObserver.
    setTimeout(() => scan(false), 1500);
    setTimeout(() => scan(false), 3500);
    mo.observe(document.body, { childList: true, subtree: true });
  })();
})();
