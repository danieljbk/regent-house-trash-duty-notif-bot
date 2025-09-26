const WORKER_URL = 'https://trashbotapi.kwon.ai'

// Get references to all the HTML elements
const onDutyEl = document.getElementById('on-duty')
const onDutyDatesEl = document.getElementById('on-duty-dates')
const upcomingListEl = document.getElementById('upcoming-list')
const penaltyStatusEl = document.getElementById('penalty-status')
const lastWeekReportEl = document.getElementById('last-week-report')
const reportButton = document.getElementById('report-button')
const reportResponseEl = document.getElementById('report-response')
const lastWeekEl = document.getElementById('last-week')

const MAX_UPCOMING_ROWS = 3

// --- NEW, STABLE DATE HELPER FUNCTIONS ---

/**
 * Calculates the date of the Monday for the week of the given date.
 * @param {Date} d - The reference date.
 * @returns {Date} - The date of the Monday of that week.
 */
const getStartOfWeek = (d) => {
  const date = new Date(d)
  const day = date.getDay() // Sunday = 0, Monday = 1, etc.
  const diff = date.getDate() - day + (day === 0 ? -6 : 1) // Adjust for Sunday
  return new Date(date.setDate(diff))
}

const formatDate = (date) => {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

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

/**
 * Fetches the schedule and updates the entire webpage.
 */
async function fetchSchedule() {
  try {
    const response = await fetch(`${WORKER_URL}/schedule`)
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`)
    const data = await response.json()

    // --- 1. ESTABLISH STABLE DATE ANCHORS ---
    const today = new Date()
    const startOfWeek = getStartOfWeek(today) // The Monday of this week
    const endOfWeek = new Date(startOfWeek)
    endOfWeek.setDate(startOfWeek.getDate() + 6) // The Sunday of this week

    // --- 2. Populate Hero Card with Correct Dates ---
    onDutyEl.textContent = data.onDuty
    onDutyDatesEl.textContent = `${formatDate(startOfWeek)} – ${formatDate(
      endOfWeek
    )}`

    // --- 3. Populate Secondary Info ---
    lastWeekEl.textContent = data.lastWeek
    lastWeekReportEl.textContent = data.lastWeek

    // --- 4. Populate Upcoming Schedule Table with Correct Dates ---
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
      // Calculate each upcoming week's Monday based on the stable anchor
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

    // --- 5. Handle Penalty Banner ---
    if (data.penaltyInfo && data.penaltyInfo.weeksRemaining > 0) {
      const info = data.penaltyInfo
      const offenderName = info.offenderName || data.lastWeek
      let bannerText = ''

      if (info.isActive) {
        bannerText = `PENALTY ACTIVE: ${offenderName} has ${info.weeksRemaining} ${info.weekString} remaining. The normal rotation is paused.`
      } else if (info.startsNextRotation) {
        bannerText = `Penalty recorded: ${offenderName} owes ${info.weeksRemaining} ${info.weekString}. The rotation will pause after this week.`
      } else {
        bannerText = `Penalty recorded for ${offenderName}.`
      }

      penaltyStatusEl.textContent = bannerText
      penaltyStatusEl.style.display = 'block'
    } else {
      penaltyStatusEl.style.display = 'none'
    }
  } catch (error) {
    console.error('Failed to fetch schedule:', error)
    onDutyEl.textContent = 'Could not load schedule.'
  }
}

/**
 * Event listener for the "Report Missed Duty" button.
 */
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
    reportResponseEl.textContent = result.message
    fetchSchedule()
  } catch (error) {
    reportResponseEl.textContent = 'An error occurred.'
  } finally {
    reportButton.disabled = false
  }
})

// Initial load
document.addEventListener('DOMContentLoaded', fetchSchedule)
