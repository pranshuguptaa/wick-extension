/**
 * Wick — popup logic (vanilla JS), rebuilt.
 *
 * Reads cached/live usage from claude.ai and paints two SVG arc gauges,
 * a messages-left estimate, per-window countdowns, and handoff buttons.
 * Works even when claude.ai is closed (falls back to the last cached
 * usage; gauges show 0% / dashes if nothing).
 */
(() => {
  'use strict';



  const MODEL_MULT = { opus: 5, sonnet: 2, haiku: 1 };
  const DELTA_WINDOW = 5;

  const DEST_URL = {
    chatgpt: 'https://chatgpt.com/',
    gemini: 'https://gemini.google.com/app',
    grok: 'https://grok.com/',
  };

  const $ = (id) => document.getElementById(id);
  const storageGet = (k) => new Promise((r) => chrome.storage.local.get(k, r));
  const storageSet = (o) => new Promise((r) => chrome.storage.local.set(o, r));

  // ---- gauge --------------------------------------------------------------
  function setGauge(svgId, fraction, color) {
    const RADIUS = 38;
    const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // 238.76
    const f = Math.max(0, Math.min(fraction || 0, 1));
    const offset = CIRCUMFERENCE * (1 - f);
    const arc = document.querySelector(`#${svgId} .progress-arc`);
    if (arc) {
      arc.setAttribute('stroke-dashoffset', offset.toFixed(2));
      arc.setAttribute('stroke', color);
    }
  }

  // ---- countdown ----------------------------------------------------------
  function fmtCountdown(resetAt) {
    if (!resetAt) return '—';
    const ms = new Date(resetAt).getTime() - Date.now();
    if (isNaN(ms) || ms <= 0) return 'now';
    const t = Math.floor(ms / 1000);
    const d = Math.floor(t / 86400);
    const h = Math.floor((t % 86400) / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s}s`;
  }

  // countdowns tick live every second from the last-known reset timestamps
  const resets = { session: null, weekly: null };
  let countdownTimer = null;
  function tickCountdowns() {
    $('session-countdown').textContent = fmtCountdown(resets.session);
    $('weekly-countdown').textContent = fmtCountdown(resets.weekly);
  }

  // ---- estimate -----------------------------------------------------------
  async function estimateMessages(model, sessionFraction) {
    const key = `wick:history:${model}`;
    const hist = (await storageGet(key))[key] || [];
    const recent = hist.slice(-DELTA_WINDOW);
    const avg = recent.length
      ? recent.reduce((a, b) => a + b, 0) / recent.length
      : 0.01 * (MODEL_MULT[model] || 2);
    if (avg <= 0) return null;
    return Math.max(0, Math.floor((1 - sessionFraction) / avg));
  }

  // ---- live usage ---------------------------------------------------------
  // Real shape: { five_hour:{utilization,resets_at}, seven_day:{...}, seven_day_opus:{...} }
  // utilization is 0–100; we normalize to 0–1. Falls back to legacy fraction shape.
  function toFraction(bucket) {
    if (!bucket) return 0;
    if (typeof bucket.utilization === 'number')
      return Math.max(0, Math.min(1, bucket.utilization / 100));
    if (typeof bucket.fraction === 'number')
      return Math.max(0, Math.min(1, bucket.fraction));
    return 0;
  }

  async function fetchUsageFresh(orgId, model) {
    try {
      const res = await fetch(
        `https://claude.ai/api/organizations/${orgId}/usage`,
        { credentials: 'include', headers: { accept: 'application/json' } }
      );
      if (!res.ok) return null;
      const u = await res.json();
      const five = u.five_hour || u.session_usage || {};
      const week = u.seven_day || u.weekly_usage || {};
      const weekOpus = u.seven_day_opus || null;
      let weekly = toFraction(week);
      if (model === 'opus' && weekOpus) weekly = Math.max(weekly, toFraction(weekOpus));
      return {
        session: toFraction(five),
        weekly,
        sessionReset: five.resets_at || five.reset_at || null,
        weeklyReset: week.resets_at || week.reset_at || null,
      };
    } catch (_e) {
      return null;
    }
  }

  // Resolve the org id without depending on the content script having run.
  // The popup has host_permissions for claude.ai, so this cross-origin fetch
  // carries the user's session cookie when they're logged in.
  async function resolveOrgId(cachedId) {
    if (cachedId) return cachedId;
    try {
      const res = await fetch('https://claude.ai/api/organizations', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      const orgs = await res.json();
      if (Array.isArray(orgs) && orgs.length) {
        const chat = orgs.find(
          (o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')
        );
        const org = chat || orgs[0];
        const id = org.uuid || org.id || null;
        if (id) await storageSet({ 'wick:orgId': id });
        return id;
      }
    } catch (_e) {
      /* not logged in / offline */
    }
    return null;
  }

  // ---- main render --------------------------------------------------------
  async function render() {
    const all = await storageGet(null);

    const orgId = await resolveOrgId(all['wick:orgId']);

    // current model: prefer what the content script last saw; else the model
    // with the most recorded history.
    const cached = all['wick:lastUsage'];
    let model = cached && cached.model ? cached.model : 'sonnet';
    if (!(cached && cached.model)) {
      let bestLen = -1;
      for (const k of Object.keys(all)) {
        if (k.startsWith('wick:history:')) {
          const len = Array.isArray(all[k]) ? all[k].length : 0;
          if (len > bestLen) { bestLen = len; model = k.replace('wick:history:', ''); }
        }
      }
    }
    $('model-pill').textContent = model;

    let session = 0, weekly = 0, live = false, haveData = false;
    resets.session = null;
    resets.weekly = null;

    // 1) show cached usage immediately (works even if claude.ai is closed)
    if (cached) {
      session = cached.session || 0;
      weekly = cached.weekly || 0;
      resets.session = cached.sessionReset || cached.resetAt || null;
      resets.weekly = cached.weeklyReset || null;
      haveData = true;
    }

    // 2) refresh live if we have an org id and an active session
    if (orgId) {
      const usage = await fetchUsageFresh(orgId, model);
      if (usage) {
        live = true;
        haveData = true;
        session = usage.session;
        weekly = usage.weekly;
        resets.session = usage.sessionReset;
        resets.weekly = usage.weeklyReset;
        await storageSet({
          'wick:lastUsage': {
            session, weekly,
            sessionReset: resets.session,
            weeklyReset: resets.weekly,
            model,
            at: Date.now(),
          },
        });
      }
    }

    // gauges (amber)
    setGauge('session-gauge', session, '#f59e0b');
    setGauge('weekly-gauge', weekly, '#fbbf24');

    if (haveData) {
      $('session-pct').textContent = `${Math.round(session * 100)}%`;
      $('weekly-pct').textContent = `${Math.round(weekly * 100)}%`;
      const msgs = await estimateMessages(model, session);
      $('messages-left').textContent = msgs == null ? '—' : `≈ ${msgs.toLocaleString()}`;
      $('messages-sub').textContent = `${model} messages left`;
    } else {
      $('session-pct').textContent = '—';
      $('weekly-pct').textContent = '—';
      $('messages-left').textContent = '—';
      $('messages-sub').textContent = 'messages left';
    }

    tickCountdowns();
    if (!countdownTimer) countdownTimer = setInterval(tickCountdowns, 1000);

    // status line
    if (haveData) {
      $('status').textContent = live ? '' : 'Cached · open claude.ai to refresh';
    } else if (orgId) {
      // resolved an org but couldn't read usage — usually a login/session issue
      $('status').textContent = 'Couldn’t read usage — open claude.ai & log in';
    } else {
      $('status').textContent = 'Log in at claude.ai to start metering';
    }



  // ---- handoff (from popup) ----------------------------------------------
  function queryTabs(q) {
    return new Promise((r) => chrome.tabs.query(q, r));
  }
  function sendToTab(tabId, msg) {
    return new Promise((r) => {
      try {
        chrome.tabs.sendMessage(tabId, msg, () => r(!chrome.runtime.lastError));
      } catch (_e) {
        r(false);
      }
    });
  }

  async function handoff(dest) {
    if (!DEST_URL[dest]) return;
    const tabs = await queryTabs({ url: 'https://claude.ai/*' });
    if (tabs && tabs.length) {
      // prefer the active claude tab, else the first one
      const tab = tabs.find((t) => t.active) || tabs[0];
      const ok = await sendToTab(tab.id, { type: 'wick:handoff', dest });
      if (ok) {
        chrome.tabs.update(tab.id, { active: true });
        window.close();
        return;
      }
    }
    // no claude.ai tab (or it hasn't loaded the injector): guide the user
    $('status').textContent = 'Open a claude.ai conversation to hand off';
  }



  // ---- update banner ------------------------------------------------------
  // The service worker polls usewick.online/api/version and stashes the result in
  // storage; the popup just reflects it. When storeUrl is set (Chrome Web Store
  // is live) we nudge users to reinstall for auto-updates; otherwise we offer
  // the latest direct download.
  async function renderUpdateBanner() {
    const { updateAvailable, updateVersion, updateUrl, storeUrl } = await storageGet([
      'updateAvailable',
      'updateVersion',
      'updateUrl',
      'storeUrl',
      'updateMessage',
    ]);
    if (!updateAvailable) return;
    const banner = document.getElementById('wick-update-banner');
    if (!banner) return;
    const destination = storeUrl || updateUrl || 'https://usewick.online/install';
    const isStore = !!storeUrl;
    banner.innerHTML = `
      <span>${isStore ? 'Wick is now on the Chrome Web Store' : `v${updateVersion} available`}</span>
      <a href="${destination}" target="_blank">${isStore ? 'Reinstall for auto-updates →' : 'Download →'}</a>
    `;
    banner.style.display = 'flex';
  }

  // ---- init ---------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.handoff-btn').forEach((btn) => {
      btn.addEventListener('click', () => handoff(btn.dataset.dest));
    });
    renderUpdateBanner();
    render();
  });
})();
