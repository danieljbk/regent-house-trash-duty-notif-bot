# Automated Team Rotation Notifier with Penalty System

## 1. Project Overview

This document describes a fully automated, serverless system designed to manage a recurring, rotating duty for a team of individuals. The system addresses the challenge of manually tracking whose turn it is for a specific task (e.g., taking out the trash, on-call duty) and introduces a mechanism for accountability.

The system is built entirely on the Cloudflare serverless ecosystem and integrates with the Twilio API for SMS notifications.

### Core Features:

*   **Automated Weekly Notifications:** On a user-defined schedule, the system sends personalized SMS messages to every member of the team.
*   **Personalized Status Updates:** Each message is unique to the recipient, informing them of the current person on duty, the person for the following week, and the specific date of their own upcoming turn.
*   **Web-Based Dashboard:** A publicly accessible static webpage that displays the current rotation schedule, including who is on duty, who was on duty last, and who is coming up next.
*   **Accountability & Penalty System:** The dashboard includes a feature for team members to report a missed duty. Reporting a failure automatically places the offending member into a "Penalty Box," assigning them the duty for the next 3 consecutive weeks and pausing the normal rotation.
*   **Serverless Architecture:** The system operates with no dedicated servers, making it highly scalable, reliable, and extremely cost-effective.

## 2. System Architecture

The system consists of four primary components that interact in a specific flow:

1.  **Cloudflare Pages (Frontend):** A static HTML/CSS/JavaScript site that serves as the user-facing dashboard. It is responsible for displaying the schedule and providing the interface to report a missed duty.
2.  **Cloudflare Worker (Backend/API):** The core logic engine. It serves two functions:
    *   **API:** Listens for `GET` requests from the Pages frontend to serve the current schedule data and `POST` requests to handle missed duty reports.
    *   **Cron Job:** Executes on an automated schedule (e.g., weekly) to run the main notification logic.
3.  **Cloudflare KV (Database):** A key-value data store that acts as the single source of truth for the application state. It stores the team member list, the current rotation index, and the penalty status.
4.  **Twilio API (Notification Service):** An external service used by the Cloudflare Worker to send SMS messages.

### Interaction Flow:

*   **User Viewing Dashboard:**
    1.  User's browser loads the Cloudflare Pages site.
    2.  The JavaScript on the page sends a `GET` request to the `/schedule` endpoint of the Cloudflare Worker.
    3.  The Worker reads data from the Cloudflare KV namespace.
    4.  The Worker returns the schedule data as a JSON object.
    5.  The JavaScript populates the HTML with the schedule data.

*   **Automated Notification Cycle (Cron Trigger):**
    1.  The Cloudflare Cron Trigger activates the Worker on its schedule.
    2.  The Worker's `scheduled` function executes.
    3.  It reads the current state from Cloudflare KV (team list, index, penalty status).
    4.  It determines the person on duty based on penalty or normal rotation logic.
    5.  It loops through all team members, constructs a personalized message for each, and makes an API call to Twilio for every member.
    6.  It updates the state in Cloudflare KV for the next cycle (advancing the index or decrementing penalty weeks).

*   **Reporting a Missed Duty:**
    1.  User clicks the "Report Missed Duty" button on the Cloudflare Pages site.
    2.  The JavaScript sends a `POST` request to the `/report` endpoint of the Cloudflare Worker.
    3.  The Worker calculates who was on duty last week and writes a "Penalty Box" object to Cloudflare KV.
    4.  The Worker returns a success message.

## 3. Data Schema (Cloudflare KV Namespace)

The application requires a single KV Namespace bound to the Worker. The namespace must contain the following three keys:

### Key: `TEAM_MEMBERS`

*   **Purpose:** Stores the definitive list of all team members, their contact information, and the order of the rotation. The array's order dictates the rotation sequence.
*   **Value Format:** A JSON array of objects. Each object must contain a `name` (string) and a `phone` (string in E.164 format).

*   **Example Value:**
    ```json
    [
      { "name": "Vardhan", "phone": "+15103344815" },
      { "name": "Deep",    "phone": "+14084801297" },
      { "name": "Shoumik", "phone": "+15127653750" },
      { "name": "Aryan",   "phone": "+14152796774" },
      { "name": "Vikram",  "phone": "+15105569320" },
      { "name": "Shreyas", "phone": "+14088165339" },
      { "name": "Daniel",  "phone": "+14698106937" },
      { "name": "Soam",    "phone": "+14084069117" }
    ]
    ```

### Key: `CURRENT_INDEX`

*   **Purpose:** Tracks the current position in the `TEAM_MEMBERS` array for the normal rotation. This value is updated by the `scheduled` function.
*   **Value Format:** A string containing an integer.
*   **Example Value:** `3` (This would indicate Aryan is on duty in the example above).

### Key: `ROTATION_START_DATE`

*   **Purpose:** An anchor date used for calculating future rotation dates. This should be set to the date of the first rotation for the person at index 0.
*   **Value Format:** A string in `YYYY-MM-DD` format.
*   **Example Value:** `2025-09-30`

### Key: `PENALTY_BOX` (Optional)

*   **Purpose:** This key is created by the `/report` endpoint when a duty is missed. The `scheduled` function reads this key to determine if the penalty logic should override the normal rotation.
*   **Value Format:** A JSON object containing the index of the offender and the number of penalty weeks remaining. When weeksRemaining is `0`, the normal logic resumes.
*   **Example Value:**
    ```json
    {
      "offenderIndex": 2,
      "weeksRemaining": 3
    }
    ```

## 4. Environment Variables & Secrets

The Cloudflare Worker requires the following environment variables to be set in its settings for Twilio integration. These should be configured as **secrets**.

| Variable Name         | Purpose                                             | Example Value                |
| --------------------- | --------------------------------------------------- | ---------------------------- |
| `TWILIO_ACCOUNT_SID`  | Your Twilio Account SID for API authentication.     | `ACxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_AUTH_TOKEN`   | Your Twilio Auth Token for API authentication.      | `your_auth_token_string`     |
| `TWILIO_PHONE_NUMBER` | The Twilio phone number used to send the SMS.       | `+15017122661`               |

## 5. Codebase Structure and Final Code

The project consists of three files.

### 5.1. Backend (`index.js`)

This file contains the complete logic for the Cloudflare Worker. It handles the cron-triggered notifications, serves the API for the frontend, and interacts with the KV store and Twilio.

```javascript
// File: index.js

export default {
  /**
   * This is the main automated function. It runs on a Cron Trigger (e.g., once a week).
   * Its job is to calculate the schedule, send all notifications, and update the state for the next week.
   */
  async scheduled(event, env, ctx) {
    // 1. Get all necessary data from our Cloudflare KV database
    const team = await env.ROTATION_DB.get('TEAM_MEMBERS', 'json');
    if (!team || team.length === 0) {
      console.error("FATAL: Team data is missing or empty. Halting execution.");
      return;
    }
    let currentIndex = parseInt(await env.ROTATION_DB.get('CURRENT_INDEX') || '0');
    const penaltyBox = await env.ROTATION_DB.get('PENALTY_BOX', 'json') || {};
    const teamSize = team.length;

    let personOnDuty;
    let isPenaltyWeek = false;

    // 2. Core Logic: Check if there's an active penalty
    if (penaltyBox.weeksRemaining && penaltyBox.weeksRemaining > 0) {
      // PENALTY LOGIC: Someone is serving a penalty.
      isPenaltyWeek = true;
      personOnDuty = team[penaltyBox.offenderIndex]; // The offender is on duty.
      penaltyBox.weeksRemaining--; // Decrement their remaining weeks.
      await env.ROTATION_DB.put('PENALTY_BOX', JSON.stringify(penaltyBox));
      // IMPORTANT: We do NOT advance the currentIndex. The normal rotation is paused.
    } else {
      // NORMAL LOGIC: No penalty, run the standard rotation.
      personOnDuty = team[currentIndex];
      const nextIndex = (currentIndex + 1) % teamSize;
      await env.ROTATION_DB.put('CURRENT_INDEX', nextIndex.toString());
    }

    // 3. Prepare data for SMS notifications
    const nextPersonInRotation = team[(currentIndex + 1) % teamSize];
    const thisWeekDate = new Date(); // Use today's date for "this week"
    const nextWeekDate = new Date();
    nextWeekDate.setDate(thisWeekDate.getDate() + 7);

    // 4. Loop through EVERYONE on the team to send them a personalized status update
    for (const [personIndex, person] of team.entries()) {
      let weeksUntilTurn;
      if (isPenaltyWeek && penaltyBox.offenderIndex === personIndex) {
        weeksUntilTurn = 0; // If they are the offender, it's their turn.
      } else {
        // Calculate normal turn distance, ignoring any penalty
        weeksUntilTurn = (personIndex - currentIndex + teamSize) % teamSize;
      }
      
      const theirTurnDate = new Date();
      theirTurnDate.setDate(theirTurnDate.getDate() + (weeksUntilTurn * 7));

      // 5. Build the unique message for each person
      let personalStatus = '';
      if (weeksUntilTurn === 0) {
        personalStatus = `It's your turn this week, ${person.name}!`;
        if (isPenaltyWeek) {
          personalStatus += ` This is week ${3 - penaltyBox.weeksRemaining} of 3 for your penalty.`
        }
      } else if (weeksUntilTurn === 1 && !isPenaltyWeek) {
        personalStatus = `Hi ${person.name}, your turn is next week.`;
      } else {
        personalStatus = `${person.name}, your next turn is on ${formatDate(theirTurnDate)}, in ${weeksUntilTurn} weeks.`;
      }
      
      const messageBody = `Trash Duty:\n\n` +
                          `1. This week (${formatDate(thisWeekDate)}): ${personOnDuty.name}\n` +
                          `2. Next week (${formatDate(nextWeekDate)}): ${nextPersonInRotation.name}\n\n` +
                          `${personalStatus}`;

      // 6. Send the message
      await sendSms(env, person.phone, messageBody);
    }
  },

  /**
   * This function acts as our API. It listens for requests from the frontend dashboard.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Respond to pre-flight CORS requests
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    // Endpoint to get schedule data for the dashboard
    if (url.pathname === '/schedule') {
        const team = await env.ROTATION_DB.get('TEAM_MEMBERS', 'json');
        const currentIndex = parseInt(await env.ROTATION_DB.get('CURRENT_INDEX') || '0');
        const penaltyBox = await env.ROTATION_DB.get('PENALTY_BOX', 'json') || {};
        const teamSize = team.length;

        let onDutyName;
        let penaltyInfo = {};
        
        if (penaltyBox.weeksRemaining > 0) {
            onDutyName = team[penaltyBox.offenderIndex].name;
            penaltyInfo = { weeksRemaining: penaltyBox.weeksRemaining };
        } else {
            onDutyName = team[currentIndex].name;
        }
        
        const lastWeekIndex = (currentIndex - 1 + teamSize) % teamSize;
        const lastWeekName = team[lastWeekIndex].name;

        // Create a list of the next 3 people in the normal rotation
        const upcoming = [
            team[(currentIndex + 1) % teamSize].name,
            team[(currentIndex + 2) % teamSize].name,
            team[(currentIndex + 3) % teamSize].name,
        ];
        
        const responseData = {
            onDuty: onDutyName,
            lastWeek: lastWeekName,
            upcoming: upcoming,
            penaltyInfo: penaltyInfo
        };

        return new Response(JSON.stringify(responseData), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Endpoint to report a missed duty
    if (url.pathname === '/report' && request.method === 'POST') {
        const teamSize = (await env.ROTATION_DB.get('TEAM_MEMBERS', 'json')).length;
        const currentIndex = parseInt(await env.ROTATION_DB.get('CURRENT_INDEX') || '0');
        
        // The offender is the person from *last week* relative to the current index
        const offenderIndex = (currentIndex - 1 + teamSize) % teamSize;

        const penalty = {
            offenderIndex: offenderIndex,
            weeksRemaining: 3
        };
        await env.ROTATION_DB.put('PENALTY_BOX', JSON.stringify(penalty));

        const responseData = { message: 'Penalty has been recorded. The schedule will update on the next rotation.' };
        return new Response(JSON.stringify(responseData), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response('Not Found', { status: 404 });
  }
};


// --- HELPER FUNCTIONS ---

/**
 * Sends an SMS using the Twilio API.
 * @param {object} env - The environment object containing secrets.
 * @param {string} to - The recipient's phone number in E.164 format.
 * @param {string} body - The text message content.
 */
async function sendSms(env, to, body) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const data = new URLSearchParams({
    To: to,
    From: env.TWILIO_PHONE_NUMBER,
    Body: body
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)
      },
      body: data
    });
    if (!response.ok) {
        const errorData = await response.json();
        console.error(`Twilio Error for ${to}:`, errorData.message);
    } else {
        console.log(`Message sent successfully to ${to}`);
    }
  } catch (error) {
      console.error(`Failed to send message to ${to}:`, error);
  }
}

/**
 * Formats a Date object into a readable string like "Oct 1".
 * @param {Date} date - The date to format.
 * @returns {string} - The formatted date string.
 */
function formatDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
```

### 5.2. Frontend HTML (`index.html`)

This file defines the structure of the web dashboard.

```html
<!-- File: index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Team Rotation Schedule</title>
  <!-- Using a simple, clean CSS framework for looks -->
  <link rel="stylesheet" href="https://cdn.simplecss.org/simple.min.css">
  <style>
    body { max-width: 800px; margin: auto; padding: 1rem; }
    .danger-zone {
      border: 2px solid #d9534f;
      padding: 1rem;
      margin-top: 2rem;
      border-radius: 8px;
    }
    .danger-zone button {
      background-color: #d9534f;
      color: white;
      border: none;
    }
    #penalty-status {
      color: #d9534f;
      font-weight: bold;
      text-align: center;
      padding: 0.5rem;
      border: 1px solid #d9534f;
      border-radius: 4px;
      margin-bottom: 1rem;
    }
  </style>
</head>
<body>
  <header>
    <h1>Team Rotation Schedule</h1>
    <!-- This div will only appear if a penalty is active -->
    <div id="penalty-status" style="display: none;"></div>
  </header>
  <main>
    <h2>🎯 On Duty This Week</h2>
    <p id="on-duty">Loading...</p>
    
    <h2>⏮️ Last Week</h2>
    <p id="last-week">Loading...</p>

    <h2>🗓️ Upcoming Rotation</h2>
    <ul id="upcoming-list">
      <li>Loading...</li>
    </ul>

    <div class="danger-zone">
      <h3>Missed Duty?</h3>
      <p>If the person on duty last week (<strong id="last-week-report">...</strong>) did not complete the task, press this button to assign them a 3-week penalty.</p>
      <button id="report-button">Report Missed Duty</button>
      <p id="report-response"></p>
    </div>
  </main>
  <!-- Link to our JavaScript file -->
  <script src="script.js"></script>
</body>
</html>
```

### 5.3. Frontend JavaScript (`script.js`)

This file handles all client-side logic for the dashboard, including fetching data from the Worker and handling the report button action.

```javascript
// File: script.js

// IMPORTANT: This URL must be replaced with the deployed Cloudflare Worker URL.
const WORKER_URL = 'https://your-worker-name.your-subdomain.workers.dev';

// Get references to all the HTML elements we need to update
const onDutyEl = document.getElementById('on-duty');
const lastWeekEl = document.getElementById('last-week');
const upcomingList = document.getElementById('upcoming-list');
const penaltyStatusEl = document.getElementById('penalty-status');
const lastWeekReportEl = document.getElementById('last-week-report');
const reportButton = document.getElementById('report-button');
const reportResponseEl = document.getElementById('report-response');

/**
 * Fetches the current schedule data from our Worker API and updates the webpage.
 */
async function fetchSchedule() {
  try {
    const response = await fetch(`${WORKER_URL}/schedule`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();

    // Update the main dashboard elements
    onDutyEl.textContent = data.onDuty;
    lastWeekEl.textContent = data.lastWeek;
    lastWeekReportEl.textContent = data.lastWeek; // Also update the text in the report section

    // Clear the "Loading..." text and populate the upcoming list
    upcomingList.innerHTML = '';
    data.upcoming.forEach(name => {
      const li = document.createElement('li');
      li.textContent = name;
      upcomingList.appendChild(li);
    });

    // Handle the display of the penalty status banner
    if (data.penaltyInfo && data.penaltyInfo.weeksRemaining > 0) {
      penaltyStatusEl.textContent = `PENALTY ACTIVE: ${data.onDuty} has ${data.penaltyInfo.weeksRemaining} week(s) remaining. The normal rotation is paused.`;
      penaltyStatusEl.style.display = 'block'; // Make the banner visible
    } else {
      penaltyStatusEl.style.display = 'none'; // Hide the banner if no penalty
    }

  } catch (error) {
    console.error('Failed to fetch schedule:', error);
    onDutyEl.textContent = 'Could not load schedule. Check the Worker URL and status.';
  }
}

/**
 * Event listener for the "Report Missed Duty" button.
 */
reportButton.addEventListener('click', async () => {
  // Confirm the action with the user
  if (!confirm(`Are you sure you want to report ${lastWeekReportEl.textContent} for missing their duty?`)) {
    return;
  }
  
  try {
    reportButton.disabled = true;
    reportResponseEl.textContent = 'Submitting report...';

    // Send the POST request to our Worker's /report endpoint
    const response = await fetch(`${WORKER_URL}/report`, { method: 'POST' });
    const result = await response.json();

    reportResponseEl.textContent = result.message;
    // Refresh the schedule to show the new penalty status immediately
    fetchSchedule();
  } catch (error) {
    reportResponseEl.textContent = 'An error occurred. Please try again.';
  } finally {
    // Re-enable the button whether it succeeded or failed
    reportButton.disabled = false;
  }
});

// Fetch the schedule for the first time when the page loads
document.addEventListener('DOMContentLoaded', fetchSchedule);
```

## 6. Deployment and Setup

A step-by-step guide to deploy the system.

### Prerequisites:

1.  A Cloudflare account.
2.  A Twilio account with a provisioned phone number, Account SID, and Auth Token.
3.  A GitHub account.

### Step A: Deploy the Backend (Cloudflare Worker)

1.  **Create KV Namespace:** In the Cloudflare dashboard, navigate to `Workers & Pages` -> `KV`. Create a new namespace (e.g., `ROTATION_DB`).
2.  **Add Data to KV:** Add the three keys (`TEAM_MEMBERS`, `CURRENT_INDEX`, `ROTATION_START_DATE`) with their corresponding values as defined in Section 3.
3.  **Create Worker:** Navigate to `Workers & Pages`, click `Create application` -> `Workers` -> `Create Worker`. Give it a unique name (e.g., `team-rotation-worker`) and deploy.
4.  **Add Code:** Click `Quick Edit`, delete the default code, and paste the entire contents of the `index.js` file. Click `Save and Deploy`.
5.  **Configure Bindings:** Go to the Worker's `Settings` -> `Variables`. Under `KV Namespace Bindings`, add a binding. Set the **Variable name** to `ROTATION_DB` and select the KV namespace created in step 1.
6.  **Add Secrets:** In the same `Variables` section, under `Environment Variables`, add the three Twilio secrets (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`) as defined in Section 4. Encrypt the token.
7.  **Set Cron Trigger:** Go to the Worker's `Triggers` tab. Add a `Cron Trigger` with your desired schedule (e.g., `0 16 * * 4` for every Thursday at 4 PM UTC).

### Step B: Deploy the Frontend (Cloudflare Pages)

1.  **Prepare Files:** Create a local folder. Place the `index.html` and `script.js` files inside it.
2.  **Update Worker URL:** Open `script.js` and replace the placeholder `WORKER_URL` with the actual URL of your deployed Worker.
3.  **Upload to GitHub:** Create a new GitHub repository and upload the folder contents.
4.  **Connect Cloudflare Pages:** In the Cloudflare dashboard, go to `Workers & Pages` -> `Create application` -> `Pages` -> `Connect to Git`.
5.  **Deploy:** Select your GitHub repository. The build settings can be left as default (no framework preset). Click `Save and Deploy`. Cloudflare will provide a public URL for the dashboard.

## 7. Operational Management

### Testing Notifications Safely

To test the SMS notifications without sending messages to the entire team:

1.  **Backup Data:** Copy the value of the `TEAM_MEMBERS` key from your KV namespace and save it to a local file.
2.  **Create Test Data:** Edit the `TEAM_MEMBERS` JSON array, replacing every `phone` number with your own test phone number.
3.  **Update KV:** Paste this new test data as the value for the `TEAM_MEMBERS` key in KV.
4.  **Manually Trigger:** Go to the Worker in the Cloudflare dashboard, click `Quick Edit`, and click the `Send` button in the right-hand pane to simulate a scheduled event.
5.  **Restore:** Once testing is complete, paste the original backup data back into the `TEAM_MEMBERS` key.
