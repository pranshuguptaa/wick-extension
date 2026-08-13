# Wick — load & test in Chrome

## 1. Load the extension unpacked

1. Open **`chrome://extensions`**
2. Turn on **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the **`Wick/extension`** folder (the one with `manifest.json`)
5. Wick appears in the toolbar. Pin it (puzzle-piece icon → pin).

After any code edit: click the **↻ reload** icon on the Wick card, then reload
the claude.ai tab.

## 2. Verify the usage API on YOUR account (do this first)

The meter depends on claude.ai's private usage endpoint. Confirm the shape on
your real session before trusting the meter:

1. Open **https://claude.ai** and log in.
2. Open DevTools → **Console** and paste this:

```js
(async () => {
  const orgs = await (await fetch('/api/organizations', {credentials:'include'})).json();
  const org = orgs.find(o => o.capabilities?.includes('chat')) || orgs[0];
  const id = org.uuid || org.id;
  console.log('org id:', id, '| name:', org.name);
  const u = await (await fetch(`/api/organizations/${id}/usage`, {credentials:'include'})).json();
  console.log('RAW usage:', u);
  const f = b => b && (b.utilization ?? (b.fraction!=null ? b.fraction*100 : '?'));
  console.log('session 5h %:', f(u.five_hour || u.session_usage));
  console.log('weekly 7d  %:', f(u.seven_day || u.weekly_usage));
  console.log('opus 7d    %:', f(u.seven_day_opus));
})();
```

3. **Expected:** an org id, and percentages that match what claude.ai shows
   under Settings → Usage.
   - If `RAW usage` has keys other than `five_hour` / `seven_day`, copy the log
     and send it to me — the parser adapts to `five_hour`/`session_usage` and
     `utilization`/`fraction`, but if Anthropic renamed things again I'll add the
     new keys.

## 3. Test the meter on claude.ai

1. Reload a claude.ai chat. Within ~5s a **hairline bar** appears just under the
   composer: `NN% · ≈N sonnet msgs · resets Xh Ym` with `→ ChatGPT / Gemini / Grok`.
2. Send a message. After Claude replies, watch the % tick up over the next poll
   or two — that trains the messages-left estimate.
3. Switch the model (Opus/Sonnet/Haiku) in Claude's picker; the label's model
   name and estimate should update.

**If the bar doesn't appear:** open the console and check for `Wick`-tagged
errors. Most likely a composer selector changed — tell me what the composer
element looks like (right-click the input → Inspect) and I'll add the selector.

## 4. Test the popup

Click the Wick toolbar icon. You should see:
- Two arc gauges (session blue / weekly purple) with % + countdowns
- A big "≈ N messages left"
- Model pill (green)
- Handoff buttons

Open it with **claude.ai closed** too — it should still show the last cached
usage and "Cached · open claude.ai to refresh".

## 5. Test cross-LLM handoff

1. On a claude.ai conversation, click **→ ChatGPT** (or Gemini / Grok).
2. A new tab opens; within a couple seconds the conversation (as Markdown)
   should be pasted into that tool's input, with a toast "Wick: conversation
   loaded ✓".


**If paste fails:** the destination changed its input selector. Console-inspect
the input box on that site and send me the selector; each injector has a
fallback list that's easy to extend.

## 6. Common gotchas
- **Nothing in popup / meter is 0%:** run step 2 — the API shape is the usual
  culprit.
- **Handoff opens tab but nothing pastes:** the snapshot TTL is 90s; if the
  destination took longer to load, just click the button again.
- **Reset countdown shows `now`:** the reset timestamp already passed; it'll
  correct on the next poll.
