# Penalty System Investigation Plan

## Repository Orientation
- `index.html`: Static markup defining the dashboard layout, penalty banner container, hero card, upcoming table, and report controls.
- `style.css`: Dark-themed styling for the dashboard cards, penalty banner, and button states.
- `script.js`: Browser logic that fetches schedule data, derives upcoming assignments, renders the penalty banner, and posts penalty reports.
- `worker/src/index.js`: Cloudflare Worker serving schedule/penalty APIs, running the rotation cron, sending Twilio SMS, and persisting state in KV.
- `worker/src/wrangler.toml`: Worker deployment configuration and KV binding.

## Key Data Flow Learnings
1. The Worker stores rotation state in KV under `TEAM_MEMBERS`, `CURRENT_INDEX`, and an optional `PENALTY_BOX { offenderIndex, weeksRemaining }`.
2. Scheduled runs decrement penalty weeks, keep the penalized teammate on duty, and advance the rotation only when no penalty remains.
3. The `/schedule` handler exposes `penaltyInfo` alongside rotation data; the UI decides how to display the banner based on that payload.
4. The frontend banner previously hid whenever `weeksRemaining` dropped to zero—meaning the final penalty week looked like a brand-new penalty queued for later.
5. Upcoming table generation only consults raw `penaltyBox.weeksRemaining`, so a zero means “no more future penalty slots,” which is correct behaviour once the final week is underway.

## Changes Applied (Why & What)
1. **Worker penalty shape**: Recomputed active-week metrics so `penaltyInfo` now distinguishes between “final week in progress” and “penalty queued.” This guarantees frontends can render an accurate message even when the stored future-week counter is zero.
2. **Enhanced metadata**: Added `currentWeek`, `totalWeeks`, and `weeksRemainingAfterCurrent` fields to make banner wording explicit and reusable, instead of deriving fragile numbers in the browser.
3. **Frontend banner logic**: Switched the visibility check to rely on `bannerText`/state flags, added fallbacks for active and queued states, and clarified the final-week copy.
4. **Reset behaviour**: Ensured the banner text clears when no penalty information needs to be shown, preventing stale messaging after penalties resolve.

## Follow-Up Ideas
- Add unit tests (or integration snapshots) for `/schedule` to lock in the penalty-state permutations, including final-week transitions.
- Mirror those cases in a lightweight front-end test (e.g., Jest + DOM testing) to keep the banner copy from regressing.
- Consider surfacing an explicit boolean in the API for “penalty on duty this week” vs “penalty queued” to simplify future UI updates.
