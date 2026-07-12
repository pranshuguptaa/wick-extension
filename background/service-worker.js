/**
 * Wick — background service worker (MV3)
 *
 * Responsibilities:
 *   - Seed default storage on install.
 *   - Reset the daily handoff counter at local midnight (via chrome.alarms).
 *   - Open destination tabs on behalf of content scripts (content scripts
 *     cannot use chrome.tabs directly).
 *
 * Storage schema (chrome.storage.local):
 *   wick:history:{model} → number[]  (last 20 usage-fraction deltas)
 *   wick:billing         → { dailyCount, lastReset, licenseKey?, validated?, isPro }
 *   wick:pendingSnapshot → { markdown, timestamp, ttl } | null
 *   wick:onboarded       → boolean
 *   wick:orgId           → string (cached org id)
 */

const DAILY_ALARM = 'wick:dailyReset';
const UPDATE_ALARM = 'wickUpdateCheck';

const WICK_VERSION = '1.0.0';
const VERSION_CHECK_URL = 'https://usewick.online/api/version';

// --- update check ----------------------------------------------------------

async function checkForUpdates() {
  try {
    // cache-bust so a CDN never serves us a stale version file
    const res = await fetch(`${VERSION_CHECK_URL}?t=${Date.now()}`, {
      cache: 'no-store',
    });
    if (!res.ok) return;
    const data = await res.json();

    const updateAvailable = data.extension !== WICK_VERSION;

    await chrome.storage.local.set({
      updateAvailable,
      updateVersion: data.extension,
      updateUrl: data.updateUrl,
      storeUrl: data.storeUrl,
      updateMessage: data.message,
      lastVersionCheck: Date.now(),
    });

    if (updateAvailable) {
      chrome.action.setBadgeText({ text: 'NEW' });
      chrome.action.setBadgeBackgroundColor({ color: '#E8793C' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (_e) {
    // Silent fail — never break the extension if the API is down.
  }
}

// --- helpers ---------------------------------------------------------------

function startOfTodayMs() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now.getTime();
}

async function ensureDefaults() {
  const { 'wick:billing': billing, 'wick:onboarded': onboarded } =
    await chrome.storage.local.get(['wick:billing', 'wick:onboarded']);

  if (!billing) {
    await chrome.storage.local.set({
      'wick:billing': {
        dailyCount: 0,
        lastReset: startOfTodayMs(),
        isPro: false,
      },
    });
  }
  if (onboarded === undefined) {
    await chrome.storage.local.set({ 'wick:onboarded': false });
  }
}

async function resetDailyCountIfNeeded() {
  const { 'wick:billing': billing } = await chrome.storage.local.get('wick:billing');
  if (!billing) return ensureDefaults();
  const today = startOfTodayMs();
  if (!billing.lastReset || billing.lastReset < today) {
    billing.dailyCount = 0;
    billing.lastReset = today;
    await chrome.storage.local.set({ 'wick:billing': billing });
  }
}

// --- lifecycle -------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  // Fire once a minute; cheap, and guarantees a same-day reset shortly after
  // midnight even if the browser was asleep at 00:00.
  chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 30 });
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 360 }); // every 6h
  checkForUpdates();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureDefaults();
  await resetDailyCountIfNeeded();
  chrome.alarms.create(DAILY_ALARM, { periodInMinutes: 30 });
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 360 });
  checkForUpdates();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === DAILY_ALARM) resetDailyCountIfNeeded();
  if (alarm.name === UPDATE_ALARM) checkForUpdates();
});

// Also check once when the worker first spins up (covers reloads/dev installs).
checkForUpdates();

// --- messaging -------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'wick:openTab' && typeof msg.url === 'string') {
    chrome.tabs.create({ url: msg.url }, (tab) => {
      sendResponse({ ok: true, tabId: tab && tab.id });
    });
    return true; // async response
  }

  if (msg.type === 'wick:resetDaily') {
    resetDailyCountIfNeeded().then(() => sendResponse({ ok: true }));
    return true;
  }
});
