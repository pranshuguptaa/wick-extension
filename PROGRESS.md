# Wick extension — build progress

Status legend: ✅ done & verified · 🟡 built, needs live test · 🔴 broken / not done

_Last updated: 2026-07-10_

## Scaffolding & non-API surface (solid)
- ✅ MV3 `manifest.json` — permissions, host perms, content scripts, popup, icons
- ✅ `background/service-worker.js` — defaults, daily-reset alarm, opens handoff tabs
- ✅ Popup UI (`popup.html/css/js`) — SVG arc gauges, model pill, handoff row, license field (rebuilt to spec, renders correctly)
- ✅ Icons 16/48/128 PNG
- ✅ Meter DOM injection with 3+ composer selector fallbacks + `MutationObserver` (SPA-safe)
- ✅ Handoff → Markdown export → `wick:pendingSnapshot` → open destination tab
- ✅ Destination injectors (ChatGPT/Gemini/Grok) — read snapshot, paste, toast
- ✅ Popup handoff buttons wired to claude tab via `wick:handoff` message
- ✅ License validation call to Polar (placeholder org id)

## Core correctness (was BROKEN — the meter read the wrong API shape)
- 🔴→✅ **Usage API response shape.** Plan assumed `session_usage.fraction` /
  `weekly_usage.fraction` / `reset_at`. The **real** claude.ai endpoint returns:
  ```json
  { "five_hour":  {"utilization": 34, "resets_at": "..."},
    "seven_day":  {"utilization": 72, "resets_at": "..."},
    "seven_day_opus": {"utilization": 93, "resets_at": "..."} }
  ```
  `utilization` is **0–100**, not a 0–1 fraction. As written the meter read
  `undefined` → showed **0% forever**. Verified against real endpoint + 2 OSS
  extensions (kuthiala/claude-usage-tracker, community reports).
  → **Fixed:** parse `five_hour`/`seven_day`(+`_opus`), divide by 100, use `resets_at`.
- 🔴→✅ **Org id selection.** Plan took `orgs[0].id`; the first org can be a
  non-chat/API org. → **Fixed:** pick the org whose `capabilities` include
  `"chat"`, use `uuid || id`.
- ✅ Content script now writes `wick:lastUsage` every poll so the popup has fresh
  data even with no live fetch (single source of truth, avoids CORS edge cases).
- 🟡 Opus weekly: when Opus is the active model, weekly meter reflects the
  binding `seven_day_opus` cap.

## Still heuristic / needs real-device confirmation
- 🟡 **Model detection** from DOM (opus/sonnet/haiku) — selector heuristic, will
  need a tweak once seen against live claude.ai markup.
- 🟡 **Messages-left estimate** — learns per-model burn from usage deltas; cold
  start uses opus=5/sonnet=2/haiku=1 multipliers. Improves as you chat.
- 🟡 **Conversation export shape** — handles `chat_messages`/`messages` +
  `sender`/`role` + `text`/`content[]`. Confirm field names on first real export.
- 🟡 **Composer selectors** — 3 fallbacks; confirm the bar lands under the input.

## To do before Web Store
- [ ] Set real `POLAR_ORG_ID` in `popup/popup.js`
- [ ] Publish → set real `CHROME_STORE_URL` in landing
- [ ] Live-test on claude.ai (see TESTING below), adjust selectors if needed
