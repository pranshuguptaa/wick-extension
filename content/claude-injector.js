/**
 * Wick — claude.ai injector (vanilla JS, MV3 content script)
 *
 * Injects a hairline usage meter beneath the composer and provides one-click
 * handoff of the current conversation to ChatGPT / Gemini / Grok.
 *
 * All data stays local. Three claude.ai endpoints are read (same-origin,
 * authenticated by the user's existing session cookie):
 *   GET /api/organizations
 *   GET /api/organizations/{orgId}/usage
 *   GET /api/organizations/{orgId}/chat_conversations/{convId}
 *
 * Storage keys (chrome.storage.local):
 *   wick:orgId, wick:history:{model}, wick:billing, wick:pendingSnapshot
 */
(() => {
  'use strict';
  if (window.__wickClaudeLoaded) return;
  window.__wickClaudeLoaded = true;

  // ---- config -------------------------------------------------------------
  const POLL_MS = 5000;
  const HISTORY_MAX = 20;
  const DELTA_WINDOW = 5;          // rolling avg over last N deltas
  const FREE_DAILY_HANDOFFS = 2;   // free tier: 2/day
  const SNAPSHOT_TTL = 90000;      // 90s
  const MODEL_MULT = { opus: 5, sonnet: 2, haiku: 1 };

  // ---- state --------------------------------------------------------------
  const state = {
    orgId: null,
    model: 'sonnet',
    session: { fraction: 0, resetAt: null },
    weekly: { fraction: 0, resetAt: null },
    lastSessionFraction: null,
    messagesLeft: null,
    countdownTimer: null,
  };

  // ---- utils --------------------------------------------------------------
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const pct = (f) => Math.round(clamp01(f) * 100);

  async function apiGet(url) {
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_e) {
      return null;
    }
  }

  // True while this content script's extension context is still valid. After
  // the extension is reloaded/updated, an old injected script lingers in the
  // page; its chrome.* calls throw "Extension context invalidated". We detect
  // that and tear down quietly instead of spamming errors.
  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_e) {
      return false;
    }
  }

  function storageGet(keys) {
    if (!extAlive()) return Promise.resolve({});
    return new Promise((r) => {
      try {
        chrome.storage.local.get(keys, (v) => r(chrome.runtime.lastError ? {} : v));
      } catch (_e) {
        r({});
      }
    });
  }
  function storageSet(obj) {
    if (!extAlive()) return Promise.resolve();
    return new Promise((r) => {
      try {
        chrome.storage.local.set(obj, () => r());
      } catch (_e) {
        r();
      }
    });
  }

  // ---- 1. org id ----------------------------------------------------------
  // The first organization is NOT always the chat one (it may be an API/console
  // org). Pick the org whose capabilities include "chat"; fall back to the
  // first. Claude uses `uuid` on some responses and `id` on others.
  async function getOrgId() {
    const cached = await storageGet('wick:orgId');
    if (cached['wick:orgId']) {
      state.orgId = cached['wick:orgId'];
      return state.orgId;
    }
    const orgs = await apiGet('https://claude.ai/api/organizations');
    if (Array.isArray(orgs) && orgs.length) {
      const chat = orgs.find(
        (o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')
      );
      const org = chat || orgs[0];
      state.orgId = org.uuid || org.id || null;
      if (state.orgId) await storageSet({ 'wick:orgId': state.orgId });
    }
    return state.orgId;
  }

  // ---- 2. usage poll ------------------------------------------------------
  // Real claude.ai response shape (utilization is a 0–100 percentage):
  //   { five_hour:  { utilization, resets_at },
  //     seven_day:  { utilization, resets_at },
  //     seven_day_opus: { utilization, resets_at } }   // opus present sometimes
  // We normalize everything to 0–1 fractions for the meter/gauges/estimates.
  async function pollUsage() {
    if (!extAlive()) return teardown();
    if (!state.orgId) return;
    const usage = await apiGet(
      `https://claude.ai/api/organizations/${state.orgId}/usage`
    );
    if (!usage) return;

    const five = usage.five_hour || usage.session_usage || {};
    const week = usage.seven_day || usage.weekly_usage || {};
    const weekOpus = usage.seven_day_opus || null;

    // accept either the real `utilization` (0–100) or a `fraction` (0–1)
    const toFraction = (bucket) => {
      if (!bucket) return 0;
      if (typeof bucket.utilization === 'number') return clamp01(bucket.utilization / 100);
      if (typeof bucket.fraction === 'number') return clamp01(bucket.fraction);
      return 0;
    };

    const newFraction = toFraction(five);
    let weeklyFraction = toFraction(week);
    // when Opus is active, the opus weekly cap is the binding constraint
    if (state.model === 'opus' && weekOpus) {
      weeklyFraction = Math.max(weeklyFraction, toFraction(weekOpus));
    }

    // ---- 4. track deltas ----
    if (state.lastSessionFraction !== null) {
      const delta = newFraction - state.lastSessionFraction;
      // only record positive, plausible deltas (a response was sent)
      if (delta > 0.00001 && delta < 0.5) {
        await recordDelta(state.model, delta);
      }
    }
    state.lastSessionFraction = newFraction;

    state.session.fraction = newFraction;
    state.session.resetAt = five.resets_at || five.reset_at || null;
    state.weekly.fraction = weeklyFraction;
    state.weekly.resetAt = week.resets_at || week.reset_at || null;

    // cache for the popup (single source of truth; works when tab is closed too)
    await storageSet({
      'wick:lastUsage': {
        session: state.session.fraction,
        weekly: state.weekly.fraction,
        sessionReset: state.session.resetAt,
        weeklyReset: state.weekly.resetAt,
        model: state.model,
        at: Date.now(),
      },
    });

    await recomputeEstimate();
    render();
  }

  async function recordDelta(model, delta) {
    const key = `wick:history:${model}`;
    const cur = (await storageGet(key))[key] || [];
    cur.push(delta);
    while (cur.length > HISTORY_MAX) cur.shift();
    await storageSet({ [key]: cur });
  }

  // ---- 5. messages-left estimate -----------------------------------------
  async function recomputeEstimate() {
    const key = `wick:history:${state.model}`;
    const hist = (await storageGet(key))[key] || [];
    const recent = hist.slice(-DELTA_WINDOW);

    let avgDelta;
    if (recent.length) {
      avgDelta = recent.reduce((a, b) => a + b, 0) / recent.length;
    } else {
      // no data yet: assume a baseline burn scaled by model multiplier.
      // ~1% of a session per haiku message is a reasonable cold-start guess.
      avgDelta = 0.01 * (MODEL_MULT[state.model] || 2);
    }
    if (avgDelta <= 0) {
      state.messagesLeft = null;
      return;
    }
    const remaining = 1 - state.session.fraction;
    state.messagesLeft = Math.max(0, Math.floor(remaining / avgDelta));
  }

  // ---- 3. model detection -------------------------------------------------
  function detectModel() {
    const candidates = [];

    // data-testid containing "model"
    document
      .querySelectorAll('[data-testid*="model" i]')
      .forEach((el) => candidates.push(el.textContent || ''));
    // aria-labels
    document
      .querySelectorAll('[aria-label*="model" i], [aria-label*="claude" i]')
      .forEach((el) => candidates.push(el.getAttribute('aria-label') || ''));
    // model-switcher buttons commonly carry the name as text
    document
      .querySelectorAll('button, [role="button"]')
      .forEach((el) => {
        const t = el.textContent || '';
        if (/opus|sonnet|haiku/i.test(t)) candidates.push(t);
      });

    const blob = candidates.join(' ').toLowerCase();
    let model = state.model;
    if (/opus/.test(blob)) model = 'opus';
    else if (/sonnet/.test(blob)) model = 'sonnet';
    else if (/haiku/.test(blob)) model = 'haiku';

    if (model !== state.model) {
      state.model = model;
      recomputeEstimate().then(render);
    }
    return state.model;
  }

  // ---- 6. meter injection -------------------------------------------------
  function findComposerContainer() {
    // multiple fallbacks — claude.ai markup shifts often
    const submit = document.querySelector('[data-testid="composer-submit-button"]');
    if (submit && submit.parentElement) {
      const box = submit.closest('form, fieldset, div');
      if (box) return box;
    }
    const editable = document.querySelector('[contenteditable="true"]');
    if (editable) {
      const box = editable.closest('form, fieldset, div');
      if (box) return box;
    }
    const prose = document.querySelector('.ProseMirror');
    if (prose && prose.parentElement) {
      return prose.closest('form, fieldset, div') || prose.parentElement;
    }
    return null;
  }

  function buildBar() {
    const bar = document.createElement('div');
    bar.id = 'wick-bar';
    bar.setAttribute('role', 'status');
    Object.assign(bar.style, {
      position: 'relative',
      width: '100%',
      maxWidth: '48rem',
      margin: '6px auto 2px',
      padding: '0',
      font: '12px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif',
      color: 'rgba(120,120,120,0.95)',
      userSelect: 'none',
      boxSizing: 'border-box',
    });

    bar.innerHTML = `
      <div class="wick-track" style="
        position:relative;height:3px;border-radius:2px;
        background:rgba(140,140,140,0.18);overflow:hidden;">
        <div class="wick-fill" style="
          position:absolute;left:0;top:0;bottom:0;width:0%;
          background:linear-gradient(90deg,#f59e0b,#fbbf24);
          transition:width .4s ease;"></div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;
                  gap:8px;margin-top:3px;flex-wrap:wrap;">
        <span class="wick-label" style="opacity:.85;white-space:nowrap;"></span>
        <div class="wick-actions" style="display:flex;gap:4px;">
          <button class="wick-btn" data-dest="chatgpt">→ ChatGPT</button>
          <button class="wick-btn" data-dest="gemini">→ Gemini</button>
          <button class="wick-btn" data-dest="grok">→ Grok</button>
        </div>
      </div>`;

    bar.querySelectorAll('.wick-btn').forEach((btn) => {
      Object.assign(btn.style, {
        font: 'inherit',
        fontSize: '11px',
        lineHeight: '1',
        padding: '3px 6px',
        borderRadius: '5px',
        border: '1px solid rgba(140,140,140,0.28)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        opacity: '0.75',
        transition: 'opacity .15s, background .15s',
      });
      btn.addEventListener('mouseenter', () => (btn.style.opacity = '1'));
      btn.addEventListener('mouseleave', () => (btn.style.opacity = '0.75'));
      btn.addEventListener('click', () => handoff(btn.dataset.dest));
    });

    return bar;
  }

  function ensureBar() {
    let bar = document.getElementById('wick-bar');
    if (bar && bar.isConnected) return bar;

    const container = findComposerContainer();
    if (!container || !container.parentElement) return null;

    bar = buildBar();
    // insert AFTER the composer container
    container.parentElement.insertBefore(bar, container.nextSibling);
    return bar;
  }

  function fmtCountdown(resetAt) {
    if (!resetAt) return '—';
    const ms = new Date(resetAt).getTime() - Date.now();
    if (isNaN(ms) || ms <= 0) return 'now';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
  }

  function render() {
    const bar = ensureBar();
    if (!bar) return;

    const p = pct(state.session.fraction);
    const fill = bar.querySelector('.wick-fill');
    const label = bar.querySelector('.wick-label');
    if (fill) fill.style.width = `${p}%`;

    const msgs =
      state.messagesLeft === null ? '…' : state.messagesLeft.toLocaleString();
    const countdown = fmtCountdown(state.session.resetAt);
    if (label) {
      label.textContent = `${p}% · ≈${msgs} ${state.model} msgs · resets ${countdown}`;
    }
  }

  // ---- 8. per-second countdown -------------------------------------------
  function startCountdown() {
    if (state.countdownTimer) return;
    state.countdownTimer = setInterval(() => {
      const bar = document.getElementById('wick-bar');
      if (!bar) return;
      const label = bar.querySelector('.wick-label');
      if (!label) return;
      const p = pct(state.session.fraction);
      const msgs =
        state.messagesLeft === null ? '…' : state.messagesLeft.toLocaleString();
      label.textContent = `${p}% · ≈${msgs} ${state.model} msgs · resets ${fmtCountdown(
        state.session.resetAt
      )}`;
    }, 1000);
  }

  // ---- 7. handoff ---------------------------------------------------------
  function currentConvId() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]+)/i);
    return m ? m[1] : null;
  }

  function messagesToMarkdown(conv) {
    const list = conv.chat_messages || conv.messages || [];
    const lines = [`# ${conv.name || 'Claude conversation'}`, ''];
    for (const msg of list) {
      const sender = (msg.sender || msg.role || '').toLowerCase();
      let text = '';
      if (typeof msg.text === 'string' && msg.text) text = msg.text;
      else if (Array.isArray(msg.content)) {
        text = msg.content
          .map((c) => c.text || (c.input ? JSON.stringify(c.input) : ''))
          .filter(Boolean)
          .join('\n');
      } else if (typeof msg.content === 'string') {
        text = msg.content;
      }
      if (!text.trim()) continue;
      const who = sender === 'human' || sender === 'user' ? 'Human' : 'Assistant';
      lines.push(`**${who}:** ${text.trim()}`, '');
    }
    return lines.join('\n');
  }

  async function isPro() {
    const b = (await storageGet('wick:billing'))['wick:billing'];
    return !!(b && b.isPro && b.licenseKey);
  }

  async function incDaily() {
    const b = (await storageGet('wick:billing'))['wick:billing'] || {
      dailyCount: 0,
    };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (!b.lastReset || b.lastReset < today.getTime()) {
      b.dailyCount = 0;
      b.lastReset = today.getTime();
    }
    b.dailyCount = (b.dailyCount || 0) + 1;
    await storageSet({ 'wick:billing': b });
    return b.dailyCount;
  }

  async function underDailyLimit() {
    const b = (await storageGet('wick:billing'))['wick:billing'] || {
      dailyCount: 0,
    };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const count = !b.lastReset || b.lastReset < today.getTime() ? 0 : b.dailyCount || 0;
    return count < FREE_DAILY_HANDOFFS;
  }

  async function handoff(dest) {
    const destUrl = {
      chatgpt: 'https://chatgpt.com/',
      gemini: 'https://gemini.google.com/app',
      grok: 'https://grok.com/',
    }[dest];
    if (!destUrl) return;

    const convId = currentConvId();
    if (!convId) {
      toast('Open a conversation first');
      return;
    }

    // billing gate
    if (!(await isPro()) && !(await underDailyLimit())) {
      showUpgradeModal();
      return;
    }

    toast('Wick: exporting…');
    // tree=True&rendering_mode=messages reliably returns chat_messages with text
    const conv = await apiGet(
      `https://claude.ai/api/organizations/${state.orgId}/chat_conversations/${convId}?tree=True&rendering_mode=messages`
    );
    if (!conv) {
      toast('Could not read conversation');
      return;
    }
    const markdown = messagesToMarkdown(conv);

    await storageSet({
      'wick:pendingSnapshot': {
        markdown,
        timestamp: Date.now(),
        ttl: SNAPSHOT_TTL,
      },
    });
    if (!(await isPro())) await incDaily();

    chrome.runtime.sendMessage({ type: 'wick:openTab', url: destUrl });
  }

  // ---- upgrade modal ------------------------------------------------------
  function showUpgradeModal() {
    if (document.getElementById('wick-modal')) return;
    const overlay = document.createElement('div');
    overlay.id = 'wick-modal';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      background: 'rgba(0,0,0,0.5)',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      font: '14px/1.5 ui-sans-serif, system-ui, sans-serif',
    });
    overlay.innerHTML = `
      <div style="background:#fff;color:#111;max-width:360px;width:90%;
        border-radius:14px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.3);">
        <div style="font-size:18px;font-weight:600;margin-bottom:8px;">
          You've used your 2 free handoffs today</div>
        <p style="opacity:.75;margin:0 0 18px;">Upgrade to Wick Pro for unlimited
          cross-LLM handoffs — $2/mo or $20 lifetime.</p>
        <div style="display:flex;gap:8px;">
          <a href="https://wick.app/pricing" target="_blank"
            style="flex:1;text-align:center;background:linear-gradient(90deg,#f59e0b,#fbbf24);
            color:#1a1206;text-decoration:none;padding:10px;border-radius:8px;font-weight:600;">
            Upgrade</a>
          <button id="wick-modal-close" style="flex:0 0 auto;padding:10px 14px;
            border:1px solid #ddd;background:#fff;border-radius:8px;cursor:pointer;">
            Later</button>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.id === 'wick-modal-close') overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  // ---- toast --------------------------------------------------------------
  let toastTimer = null;
  function toast(text) {
    let el = document.getElementById('wick-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wick-toast';
      Object.assign(el.style, {
        position: 'fixed',
        bottom: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(20,20,20,0.92)',
        color: '#fff',
        padding: '8px 14px',
        borderRadius: '8px',
        font: '13px ui-sans-serif, system-ui, sans-serif',
        zIndex: '2147483647',
        pointerEvents: 'none',
        transition: 'opacity .2s',
      });
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.style.opacity = '0'), 2200);
  }

  // ---- popup-triggered handoff -------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'wick:handoff' && msg.dest) {
      handoff(msg.dest);
      sendResponse({ ok: true });
    }
  });

  // ---- teardown (on extension reload/update) ------------------------------
  function teardown() {
    try { clearInterval(state.pollTimer); } catch (_e) {}
    try { clearInterval(state.countdownTimer); } catch (_e) {}
    try { state.observer && state.observer.disconnect(); } catch (_e) {}
    const bar = document.getElementById('wick-bar');
    if (bar) bar.remove();
  }

  // ---- bootstrap ----------------------------------------------------------
  async function boot() {
    await getOrgId();
    detectModel();
    await pollUsage();
    render();
    startCountdown();

    // keep meter alive across SPA navigation + re-render on model change
    state.observer = new MutationObserver(() => {
      if (!extAlive()) return teardown();
      ensureBar();
      detectModel();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });

    state.pollTimer = setInterval(pollUsage, POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
