const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const usageEl = $('usage');

function setStatus(msg, ok = true) {
  statusEl.textContent = msg;
  statusEl.style.color = ok ? '#7cd992' : '#ff8a8a';
}

async function load() {
  const s = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  $('enabled').checked = s.enabled !== false;
  for (const cb of document.querySelectorAll('[data-site]')) {
    cb.checked = s.sites?.[cb.dataset.site] !== false;
  }
  refreshUsage();
}

async function refreshUsage() {
  usageEl.textContent = 'Checking service…';
  const res = await chrome.runtime.sendMessage({ type: 'GET_USAGE' }).catch(() => null);
  if (res?.ok) {
    const u = res.usage;
    usageEl.textContent = u
      ? `Service OK · catalogue ${u.catalogue_calls ?? 0}, market ${u.market_calls ?? 0} calls today (cap ~1000/day)`
      : 'Service connected ✓';
  } else {
    usageEl.textContent = 'Service unreachable — try again shortly.';
  }
}

$('save').addEventListener('click', async () => {
  const settings = {
    enabled: $('enabled').checked,
    sites: {
      ebay: document.querySelector('[data-site=ebay]').checked,
      vinted: document.querySelector('[data-site=vinted]').checked,
      facebook: document.querySelector('[data-site=facebook]').checked,
    },
  };
  await chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings });
  setStatus('Saved.');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'RESCAN' }).catch(() => {});
  refreshUsage();
});

$('clearCache').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
  setStatus('Price cache cleared.');
});

load();
