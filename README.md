# Trash Duty Notification System

Build once, forget forever. This repository contains a fully automated rota tracker that uses Cloudflare Workers, Cloudflare KV, and Twilio SMS to keep a house (or any team) on top of trash duty. A static dashboard on Cloudflare Pages shows the schedule and lets teammates report missed weeks, automatically enforcing a three-week penalty.

## TL;DR

- **Serverless everything:** Cron-triggered Cloudflare Worker handles scheduling, SMS, and API responses; Cloudflare Pages serves the dashboard.
- **Battle-tested rotation logic:** Penalty weeks pause the normal rotation and keep the offender in place until their sentence is served.
- **KV as the source of truth:** Simple JSON keys drive both the worker and the UI. No database server required.
- **Friendly guard rails:** Runtime checks surface misconfigurations (missing KV binding, empty team, etc.) with structured JSON errors instead of crashes.

## Repository Layout

```
.
├── index.html          # Cloudflare Pages entry point (the dashboard shell)
├── script.js           # Dashboard behaviour (fetch schedule, report penalty)
├── style.css           # Optional local styling (not referenced by default)
└── worker
    └── src
        ├── index.js    # Cloudflare Worker (cron + API)
        └── wrangler.toml
```

## End-to-End Architecture

| Layer | What Runs Here | Key Responsibilities |
| ----- | --------------- | -------------------- |
| Cloudflare Worker | `worker/src/index.js` | Sends weekly SMS, exposes `/schedule` & `/report`, reads/writes KV |
| Cloudflare KV | Namespace bound as `ROTATION_DB` | Stores `TEAM_MEMBERS`, `CURRENT_INDEX`, `PENALTY_BOX` |
| Twilio | REST API | Delivers SMS messages to each teammate |
| Cloudflare Pages | `index.html` + `script.js` | Public schedule dashboard + penalty report button |

### Request & Notification Flow

1. **Dashboard Load**  
   Browser requests the Cloudflare Pages site → `script.js` issues `GET https://<worker>/schedule` → Worker pulls state from KV → JSON payload paints the UI.

2. **Weekly Cron Execution**  
   Cloudflare Cron Trigger invokes `scheduled()` → Worker reads current rotation and penalty state → Updates penalty weeks or advances the rotation → Sends personalised SMS via Twilio → Writes new state back to KV.

3. **Report Missed Duty**  
   A teammate hits “Report Missed Duty” → Frontend sends `POST https://<worker>/report` → Worker identifies last week’s assignee → Saves `{ offenderIndex, weeksRemaining: 3 }` to `PENALTY_BOX` → Dashboard refresh shows penalty banner.

## Cloudflare Worker (Backend)

### Environment Bindings

Configure the Worker with:

- **KV Namespace**: Bind `ROTATION_DB` to the namespace containing the rotation data.
- **Secrets**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (set via `wrangler secret put` or the dashboard).

If `ROTATION_DB` is missing or misbound, the Worker now returns a JSON 500 with `"Server configuration error"` instead of throwing `Cannot read properties of undefined`.

### Scheduled Handler Logic

High-level steps:

1. Validate that `ROTATION_DB` is available.
2. Fetch `TEAM_MEMBERS`, `CURRENT_INDEX`, and optional `PENALTY_BOX`.
3. If a penalty is active, decrement `weeksRemaining`; otherwise, advance `CURRENT_INDEX`.
4. Calculate “on duty” and “next up” respecting penalty overrides.
5. Loop through every teammate and send personalised SMS with their specific status.

### Fetch Handler API

`/schedule` (GET)

- Returns the current state for the dashboard: who is on duty, who handled last week, the full team config, current index, and penalty metadata.
- On misconfiguration (missing binding or empty team), sends a structured 500 with CORS headers so the frontend can surface a friendly error.

`/report` (POST)

- Identifies the offender as `(currentIndex - 1 + teamSize) % teamSize` (the person who should have worked last week).
- Stores a `{ offenderIndex, weeksRemaining: 3 }` penalty object.
- Handles missing binding or team data with JSON 500 responses.

### Worker Source (Authoritative Reference)

````javascript
// File: worker/src/index.js

export default {
  async scheduled(event, env, ctx) {
    let rotationDb
    try {
      rotationDb = getRotationDb(env)
    } catch (error) {
      console.error(error.message)
      return
    }

    const team = await rotationDb.get('TEAM_MEMBERS', 'json')
    if (!team || team.length === 0) {
      console.error('FATAL: Team data is missing or empty.')
      return
    }

    let currentIndex = parseInt((await rotationDb.get('CURRENT_INDEX')) || '0')
    const penaltyBox = (await rotationDb.get('PENALTY_BOX', 'json')) || {}
    const teamSize = team.length

    const isPenaltyActive =
      penaltyBox.weeksRemaining && penaltyBox.weeksRemaining > 0

    if (isPenaltyActive) {
      penaltyBox.weeksRemaining--
      await rotationDb.put('PENALTY_BOX', JSON.stringify(penaltyBox))
    } else {
      currentIndex = (currentIndex + 1) % teamSize
      await rotationDb.put('CURRENT_INDEX', currentIndex.toString())
    }

    let personOnDuty
    let nextPersonUp

    if (isPenaltyActive) {
      personOnDuty = team[penaltyBox.offenderIndex]
      nextPersonUp = penaltyBox.weeksRemaining >= 1
        ? personOnDuty
        : team[currentIndex]
    } else {
      personOnDuty = team[currentIndex]
      nextPersonUp = team[(currentIndex + 1) % teamSize]
    }

    for (const [personIndex, person] of team.entries()) {
      let personalStatus = ''
      const thisWeekDate = new Date()

      if (isPenaltyActive) {
        if (personIndex === penaltyBox.offenderIndex) {
          personalStatus = `⚠️ ${person.name}, you are on Trash Duty.\nThis is week ${
            3 - penaltyBox.weeksRemaining
          } of 3 for your penalty.`
        } else {
          const normalWeeksUntilTurn =
            (personIndex - currentIndex + teamSize) % teamSize
          const weeksUntilTurn =
            normalWeeksUntilTurn + penaltyBox.weeksRemaining + 1
          const theirTurnDate = new Date()
          theirTurnDate.setDate(thisWeekDate.getDate() + weeksUntilTurn * 7)
          const weekString = weeksUntilTurn === 1 ? 'week' : 'weeks'
          personalStatus = `${
            person.name
          }, your next Trash Duty is in ${weeksUntilTurn} ${weekString} (week of ${formatDate(
            theirTurnDate
          )}).`
        }
      } else {
        const weeksUntilTurn =
          (personIndex - currentIndex + teamSize) % teamSize
        const theirTurnDate = new Date()
        theirTurnDate.setDate(thisWeekDate.getDate() + weeksUntilTurn * 7)
        if (weeksUntilTurn === 0) {
          personalStatus = `${
            person.name
          }, you are on Trash Duty this week (week of ${formatDate(
            theirTurnDate
          )}).`
        } else {
          const weekString = weeksUntilTurn === 1 ? 'week' : 'weeks'
          personalStatus = `${
            person.name
          }, your next Trash Duty is in ${weeksUntilTurn} ${weekString} (week of ${formatDate(
            theirTurnDate
          )}).`
        }
      }

      const messageBody =
        `${personalStatus}\n\n` +
        `🎯 This Week: ${personOnDuty.name}\n` +
        `➡️ Next Week: ${nextPersonUp.name}\n\n` +
        `🗓️ Full Schedule:\n` +
        `https://trash.kwon.ai\n\n` +
        `❕ Missed a duty? Report it on the site.`

      await sendSms(env, person.phone, messageBody)
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    if (url.pathname === '/schedule') {
      try {
        const rotationDb = getRotationDb(env)
        const team = await rotationDb.get('TEAM_MEMBERS', 'json')
        if (!Array.isArray(team) || team.length === 0) {
          throw new Error('Team data is missing or empty.')
        }
        const currentIndex = parseInt(
          (await rotationDb.get('CURRENT_INDEX')) || '0'
        )
        const penaltyBox =
          (await rotationDb.get('PENALTY_BOX', 'json')) || {}
        const teamSize = team.length

        let onDutyName,
          lastWeekName,
          penaltyInfo = {}
        const isPenaltyActive =
          penaltyBox.weeksRemaining && penaltyBox.weeksRemaining > 0

        if (isPenaltyActive) {
          onDutyName = team[penaltyBox.offenderIndex].name
          const weekString = penaltyBox.weeksRemaining === 1 ? 'week' : 'weeks'
          penaltyInfo = {
            weeksRemaining: penaltyBox.weeksRemaining,
            weekString: weekString,
          }
          if (penaltyBox.weeksRemaining < 3) {
            lastWeekName = onDutyName
          } else {
            lastWeekName = team[(currentIndex - 1 + teamSize) % teamSize].name
          }
        } else {
          onDutyName = team[currentIndex].name
          lastWeekName = team[(currentIndex - 1 + teamSize) % teamSize].name
        }

        const responseData = {
          onDuty: onDutyName,
          lastWeek: lastWeekName,
          team: team,
          currentIndex: currentIndex,
          penaltyBox: penaltyBox,
          penaltyInfo: penaltyInfo,
        }

        return new Response(JSON.stringify(responseData), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      } catch (error) {
        console.error('Failed to load schedule:', error.message)
        return new Response(
          JSON.stringify({
            error: 'Server configuration error. Please try again later.',
          }),
          {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        )
      }
    }

    if (url.pathname === '/report' && request.method === 'POST') {
      let rotationDb
      try {
        rotationDb = getRotationDb(env)
      } catch (error) {
        console.error(error.message)
        return new Response(
          JSON.stringify({
            error: 'Server configuration error. Please try again later.',
          }),
          {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        )
      }
      const teamData = await rotationDb.get('TEAM_MEMBERS', 'json')
      if (!Array.isArray(teamData) || teamData.length === 0) {
        return new Response(
          JSON.stringify({
            error: 'Team data is missing. Penalty cannot be recorded.',
          }),
          {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        )
      }
      const teamSize = teamData.length
      const currentIndex = parseInt(
        (await rotationDb.get('CURRENT_INDEX')) || '0'
      )
      const offenderIndex = (currentIndex - 1 + teamSize) % teamSize

      const penalty = { offenderIndex: offenderIndex, weeksRemaining: 3 }
      await rotationDb.put('PENALTY_BOX', JSON.stringify(penalty))

      const responseData = {
        message:
          'Penalty has been recorded. The schedule will update on the next rotation.',
      }

      return new Response(JSON.stringify(responseData), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response('Not Found', { status: 404 })
  },
}

async function sendSms(env, to, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`
  const data = new URLSearchParams({
    To: to,
    From: env.TWILIO_PHONE_NUMBER,
    Body: body,
  })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      },
      body: data,
    })
    if (!response.ok) {
      const errorData = await response.json()
      console.error(`Twilio Error for ${to}:`, errorData.message)
    } else {
      console.log(`Message sent successfully to ${to}`)
    }
  } catch (error) {
    console.error(`Failed to send message to ${to}:`, error)
  }
}

function getRotationDb(env) {
  const kv = env?.ROTATION_DB
  if (!kv || typeof kv.get !== 'function') {
    throw new Error('ROTATION_DB binding is not configured.')
  }
  return kv
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
````

## Data Model (Cloudflare KV)

| Key | Required? | Description |
| --- | --------- | ----------- |
| `TEAM_MEMBERS` | Yes | JSON array of `{ name, phone }` objects. Index order defines rotation order. |
| `CURRENT_INDEX` | Yes | Stringified integer. Points to the teammate currently on duty when no penalty is active. |
| `PENALTY_BOX` | Optional | JSON object `{ offenderIndex, weeksRemaining }`. Created when a penalty is filed and removed or reset by the rotation logic. |
| `ROTATION_START_DATE` | Optional | Previously used for date math; kept for backwards compatibility if you still rely on it. The current logic computes dates relative to “today.” |

Example `TEAM_MEMBERS` payload:

```json
[
  { "name": "Alex",    "phone": "+10000000001" },
  { "name": "Bobby",   "phone": "+10000000002" },
  { "name": "Casey",   "phone": "+10000000003" },
  { "name": "Dakota",  "phone": "+10000000004" },
  { "name": "Emerson", "phone": "+10000000005" },
  { "name": "Frankie", "phone": "+10000000006" },
  { "name": "Harper",  "phone": "+10000000007" },
  { "name": "Indigo",  "phone": "+10000000008" }
]
```

## Frontend Dashboard

The Pages site is intentionally lightweight: plain HTML and vanilla JS. Swap in your own styling if you like—the data contract stays the same.

### `index.html`

````html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Regent House Trash Duty</title>
    <link
      rel="icon"
      href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🗑️</text></svg>"
    />
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <header>
      <h1>Regent House Trash Duty</h1>
    </header>

    <main>
      <div id="penalty-status" class="penalty-banner" style="display: none"></div>

      <div class="card hero-card">
        <p class="label">🎯 On Duty This Week</p>
        <h2 class="person-name" id="on-duty">Loading...</h2>
        <p class="date-range" id="on-duty-dates">Loading...</p>
      </div>

      <div class="card">
        <p class="label">🗓️ Upcoming Schedule</p>
        <table class="schedule-table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Week of</th>
            </tr>
          </thead>
          <tbody id="upcoming-list"></tbody>
        </table>
      </div>

      <div class="card danger-zone">
        <h3>⚠️ Missed Duty?</h3>
        <p>
          If the person on duty last week (<strong id="last-week-report">...</strong>)
          did not complete the task, press this button to assign a penalty.
        </p>
        <button id="report-button">Report Missed Duty</button>
        <p id="report-response"></p>
      </div>

      <div class="secondary-info">
        <p>Last Week: <strong id="last-week">...</strong></p>
      </div>
    </main>

    <script src="script.js"></script>
  </body>
</html>
````

### `script.js`

````javascript
const WORKER_URL = 'https://your-worker-name.your-subdomain.workers.dev'

const onDutyEl = document.getElementById('on-duty')
const onDutyDatesEl = document.getElementById('on-duty-dates')
const upcomingListEl = document.getElementById('upcoming-list')
const penaltyStatusEl = document.getElementById('penalty-status')
const lastWeekReportEl = document.getElementById('last-week-report')
const reportButton = document.getElementById('report-button')
const reportResponseEl = document.getElementById('report-response')
const lastWeekEl = document.getElementById('last-week')

const MAX_UPCOMING_ROWS = 3

const getStartOfWeek = (d) => {
  const date = new Date(d)
  const day = date.getDay()
  const diff = date.getDate() - day + (day === 0 ? -6 : 1)
  return new Date(date.setDate(diff))
}

const formatDate = (date) =>
  date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

const deriveUpcoming = (data) => {
  if (Array.isArray(data.upcoming) && data.upcoming.length > 0) {
    return data.upcoming
  }

  const team = Array.isArray(data.team) ? data.team : []
  if (team.length === 0) return []

  const currentIndex = Number.parseInt(data.currentIndex, 10)
  if (Number.isNaN(currentIndex)) return []

  const penaltyBox = data.penaltyBox || {}
  let penaltyWeeks = Number.parseInt(penaltyBox.weeksRemaining, 10)
  if (Number.isNaN(penaltyWeeks) || penaltyWeeks < 0) penaltyWeeks = 0
  const offenderIndex = Number.isInteger(penaltyBox.offenderIndex)
    ? penaltyBox.offenderIndex
    : undefined

  const names = []
  let pointer = currentIndex

  for (let step = 0; step < MAX_UPCOMING_ROWS; step++) {
    if (penaltyWeeks > 0 && offenderIndex !== undefined) {
      const offender = team[offenderIndex]
      if (!offender) break
      names.push(offender.name)
      penaltyWeeks--
      continue
    }

    pointer = (pointer + 1) % team.length
    const person = team[pointer]
    if (!person) break
    names.push(person.name)
  }

  return names
}

async function fetchSchedule() {
  try {
    const response = await fetch(`${WORKER_URL}/schedule`)
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    const data = await response.json()

    const today = new Date()
    const startOfWeek = getStartOfWeek(today)
    const endOfWeek = new Date(startOfWeek)
    endOfWeek.setDate(startOfWeek.getDate() + 6)

    onDutyEl.textContent = data.onDuty
    onDutyDatesEl.textContent = `${formatDate(startOfWeek)} – ${formatDate(
      endOfWeek
    )}`

    lastWeekEl.textContent = data.lastWeek
    lastWeekReportEl.textContent = data.lastWeek

    const upcomingNames = deriveUpcoming(data)
    upcomingListEl.innerHTML = ''

    if (upcomingNames.length === 0) {
      const row = document.createElement('tr')
      const cell = document.createElement('td')
      cell.colSpan = 2
      cell.textContent = 'No upcoming rotation data available.'
      row.appendChild(cell)
      upcomingListEl.appendChild(row)
    }

    upcomingNames.forEach((name, index) => {
      const upcomingWeekStart = new Date(startOfWeek)
      upcomingWeekStart.setDate(startOfWeek.getDate() + (index + 1) * 7)

      const row = document.createElement('tr')
      const nameCell = document.createElement('td')
      const dateCell = document.createElement('td')

      nameCell.textContent = name
      dateCell.textContent = formatDate(upcomingWeekStart)

      row.appendChild(nameCell)
      row.appendChild(dateCell)
      upcomingListEl.appendChild(row)
    })

    if (data.penaltyInfo && data.penaltyInfo.weeksRemaining > 0) {
      penaltyStatusEl.textContent = `PENALTY ACTIVE: ${data.onDuty} has ${data.penaltyInfo.weeksRemaining} ${data.penaltyInfo.weekString} remaining. The normal rotation is paused.`
      penaltyStatusEl.style.display = 'block'
    } else if (data.error) {
      penaltyStatusEl.textContent = data.error
      penaltyStatusEl.style.display = 'block'
    } else {
      penaltyStatusEl.style.display = 'none'
    }
  } catch (error) {
    console.error('Failed to fetch schedule:', error)
    onDutyEl.textContent = 'Could not load schedule.'
  }
}

reportButton.addEventListener('click', async () => {
  if (
    !confirm(
      `Are you sure you want to report ${lastWeekReportEl.textContent} for missing their duty?`
    )
  )
    return

  try {
    reportButton.disabled = true
    reportResponseEl.textContent = 'Submitting report...'
    const response = await fetch(`${WORKER_URL}/report`, { method: 'POST' })
    const result = await response.json()
    reportResponseEl.textContent = result.message || result.error
    await fetchSchedule()
  } catch (error) {
    reportResponseEl.textContent = 'An error occurred. Please try again.'
  } finally {
    reportButton.disabled = false
  }
})

document.addEventListener('DOMContentLoaded', fetchSchedule)
````

The frontend now derives the “Upcoming Schedule” directly from `team`, `currentIndex`, and `penaltyBox`, so the UI stays accurate even if the Worker omits an `upcoming` array.

## Deployment Playbook

### Prerequisites

- Cloudflare account with Workers & Pages enabled.
- Twilio account with messaging-capable number.
- `wrangler` CLI (v3+) installed locally.

### Backend (Worker)

1. **Create KV Namespace** → `Workers & Pages` → `KV` → `Create namespace` (e.g., `trash-duty-rotation`).
2. **Bind Namespace** → Worker → `Settings` → `Variables` → `KV Namespace Bindings` → Add binding with variable name `ROTATION_DB`.
3. **Populate Keys** → Use the dashboard or `wrangler kv:key put` to upload `TEAM_MEMBERS`, `CURRENT_INDEX`, and optional `PENALTY_BOX` (omit to start clean).
4. **Upload Code** → Deploy the Worker with `wrangler deploy` or Cloudflare dashboard quick edit using `worker/src/index.js`.
5. **Add Secrets** → `wrangler secret put TWILIO_ACCOUNT_SID` (repeat for the other two secrets) or set them in the dashboard.
6. **Cron Trigger** → Worker → `Triggers` → `Add Cron` → choose your cadence (e.g., `0 16 * * 4` for Thursdays at 16:00 UTC).

### Frontend (Pages)

1. **Customize `WORKER_URL`** in `script.js` so the dashboard knows where to fetch data.
2. **Push to GitHub** (or any git provider Pages supports).
3. **Create Pages Project** → `Workers & Pages` → `Create application` → `Pages` → `Connect to Git` → select repository.
4. **Build Settings** → Framework preset “None”; build command empty; output directory `/`.
5. **Deploy** → Cloudflare will provide a permanent URL (map a custom domain if you’d like).

## Operations & Maintenance

- **Verify KV Binding**: If `/schedule` returns `{ "error": "Server configuration error..." }`, confirm the namespace is bound as `ROTATION_DB` in both Preview and Production environments.
- **Twilio Monitoring**: Twilio errors are logged with `console.error`. Check Cloudflare Worker logs if SMS are not delivered.
- **Adjusting the rotation**: Update the `TEAM_MEMBERS` JSON (order matters). Optionally reset `CURRENT_INDEX` to align with a new starting point.
- **Clearing penalties**: Delete `PENALTY_BOX` or set `weeksRemaining` to `0` in KV to resume normal rotation immediately.

### Testing Notifications Without Spamming the Team

1. Copy the current `TEAM_MEMBERS` value and store it locally.
2. Replace all phone numbers with your own test number.
3. Trigger the Worker manually from the Cloudflare dashboard (`Quick Edit` → `Send`).
4. Restore the original JSON when finished.

## Local Development Tips

- Use `wrangler dev --test-scheduled` to simulate cron execution locally (ensure you stub the Twilio fetch or use test credentials).
- Cloudflare’s preview environment has its own bindings—double-check the KV namespace and secrets are configured for both environments if using `wrangler`.

## Appendix: Wrangler Configuration

```
name = "regent-house-trash-duty-notif-worker"
compatibility_date = "2025-09-26"
main = "src/index.js"

[observability.logs]
enabled = true
```

Set this file (`worker/src/wrangler.toml`) as the root when running `wrangler` commands, or pass `--config worker/src/wrangler.toml` from the repo root.
