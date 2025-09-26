// IMPORTANT: Replace this with your actual Cloudflare Worker URL
const WORKER_URL =
  'https://regent-house-trash-duty-notif-worker.djbkwon.workers.dev'

// Get references to all the HTML elements we need to update
const onDutyEl = document.getElementById('on-duty')
const lastWeekEl = document.getElementById('last-week')
const upcomingList = document.getElementById('upcoming-list')
const penaltyStatusEl = document.getElementById('penalty-status')
const lastWeekReportEl = document.getElementById('last-week-report')
const reportButton = document.getElementById('report-button')
const reportResponseEl = document.getElementById('report-response')

/**
 * Fetches the current schedule data from our Worker API and updates the webpage.
 */
async function fetchSchedule() {
  try {
    const response = await fetch(`${WORKER_URL}/schedule`)
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    const data = await response.json()

    // Update the main dashboard elements
    onDutyEl.textContent = data.onDuty
    lastWeekEl.textContent = data.lastWeek
    lastWeekReportEl.textContent = data.lastWeek // Also update the text in the report section

    // Clear the "Loading..." text and populate the upcoming list
    upcomingList.innerHTML = ''
    data.upcoming.forEach((name) => {
      const li = document.createElement('li')
      li.textContent = name
      upcomingList.appendChild(li)
    })

    // Handle the display of the penalty status banner
    if (data.penaltyInfo && data.penaltyInfo.weeksRemaining > 0) {
      penaltyStatusEl.textContent = `PENALTY ACTIVE: ${data.onDuty} has ${data.penaltyInfo.weeksRemaining} week(s) remaining. The normal rotation is paused.`
      penaltyStatusEl.style.display = 'block' // Make the banner visible
    } else {
      penaltyStatusEl.style.display = 'none' // Hide the banner if no penalty
    }
  } catch (error) {
    console.error('Failed to fetch schedule:', error)
    onDutyEl.textContent =
      'Could not load schedule. Check the Worker URL and status.'
  }
}

/**
 * Event listener for the "Report Missed Duty" button.
 */
reportButton.addEventListener('click', async () => {
  // Confirm the action with the user
  if (
    !confirm(
      `Are you sure you want to report ${lastWeekReportEl.textContent} for missing their duty?`
    )
  ) {
    return
  }

  try {
    reportButton.disabled = true
    reportResponseEl.textContent = 'Submitting report...'

    // Send the POST request to our Worker's /report endpoint
    const response = await fetch(`${WORKER_URL}/report`, { method: 'POST' })
    const result = await response.json()

    reportResponseEl.textContent = result.message
    // Refresh the schedule to show the new penalty status immediately
    fetchSchedule()
  } catch (error) {
    reportResponseEl.textContent = 'An error occurred. Please try again.'
  } finally {
    // Re-enable the button whether it succeeded or failed
    reportButton.disabled = false
  }
})

// Fetch the schedule for the first time when the page loads
document.addEventListener('DOMContentLoaded', fetchSchedule)
