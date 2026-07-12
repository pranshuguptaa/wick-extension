/**
 * Wick — chatgpt.com injector
 * Reads wick:pendingSnapshot and pastes the exported Markdown into the composer.
 */
(() => {
  'use strict';
  if (window.__wickChatgptLoaded) return;
  window.__wickChatgptLoaded = true;

  const storageGet = (k) => new Promise((r) => chrome.storage.local.get(k, r));
  const storageRemove = (k) => new Promise((r) => chrome.storage.local.remove(k, r));

  function findInput() {
    const sels = [
      '[data-testid="prompt-textarea"]',
      '#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
      'textarea[data-id]',
      'main [contenteditable="true"]',
      'textarea',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function setValue(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
    } else {
      // contenteditable / ProseMirror
      el.textContent = text;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function toast(text) {
    const el = document.createElement('div');
    el.textContent = text;
    Object.assign(el.style, {
      position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(20,20,20,0.92)', color: '#fff', padding: '8px 14px',
      borderRadius: '8px', font: '13px ui-sans-serif, system-ui, sans-serif',
      zIndex: '2147483647', pointerEvents: 'none', transition: 'opacity .3s',
    });
    document.body.appendChild(el);
    setTimeout(() => (el.style.opacity = '0'), 2400);
    setTimeout(() => el.remove(), 2900);
  }

  async function tryPaste(attempt = 0) {
    const snap = (await storageGet('wick:pendingSnapshot'))['wick:pendingSnapshot'];
    if (!snap || Date.now() - snap.timestamp > (snap.ttl || 90000)) return;

    const input = findInput();
    if (!input) {
      if (attempt < 20) return setTimeout(() => tryPaste(attempt + 1), 500);
      return;
    }
    setValue(input, snap.markdown);
    await storageRemove('wick:pendingSnapshot');
    toast('Wick: conversation loaded ✓');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => tryPaste(), { once: true });
  } else {
    tryPaste();
  }
})();
