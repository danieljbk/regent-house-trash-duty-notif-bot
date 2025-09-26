export default {
  /**
   * This is the main automated function. It runs on a Cron Trigger (e.g., once a week).
   * Its job is to calculate the schedule, send all notifications, and update the state for the next week.
   */
  async scheduled(event, env, ctx) {
    // 1. Get all necessary data from our Cloudflare KV database
    const team = await env.ROTATION_DB.get('TEAM_MEMBERS', 'json')
    if (!team || team.length === 0) {
      console.error('FATAL: Team data is missing or empty. Halting execution.')
      return
    }
    let currentIndex = parseInt(
      (await env.ROTATION_DB.get('CURRENT_INDEX')) || '0'
    )
    const startDate = new Date(await env.ROTATION_DB.get('ROTATION_START_DATE'))
    const penaltyBox = (await env.ROTATION_DB.get('PENALTY_BOX', 'json')) || {}
    const teamSize = team.length

    let personOnDuty
    let isPenaltyWeek = false

    // 2. Core Logic: Check if there's an active penalty
    if (penaltyBox.weeksRemaining && penaltyBox.weeksRemaining > 0) {
      // PENALTY LOGIC: Someone is serving a penalty.
      isPenaltyWeek = true
      personOnDuty = team[penaltyBox.offenderIndex] // The offender is on duty.
      penaltyBox.weeksRemaining-- // Decrement their remaining weeks.
      await env.ROTATION_DB.put('PENALTY_BOX', JSON.stringify(penaltyBox))
      // IMPORTANT: We do NOT advance the currentIndex. The normal rotation is paused.
    } else {
      // NORMAL LOGIC: No penalty, run the standard rotation.
      personOnDuty = team[currentIndex]
      const nextIndex = (currentIndex + 1) % teamSize
      await env.ROTATION_DB.put('CURRENT_INDEX', nextIndex.toString())
    }

    // 3. Prepare data for SMS notifications
    const nextPersonInRotation = team[(currentIndex + 1) % teamSize]
    const thisWeekDate = new Date() // Use today's date for "this week"
    const nextWeekDate = new Date()
    nextWeekDate.setDate(thisWeekDate.getDate() + 7)

    // 4. Loop through EVERYONE on the team to send them a personalized status update
    for (const [personIndex, person] of team.entries()) {
      let weeksUntilTurn
      if (isPenaltyWeek && penaltyBox.offenderIndex === personIndex) {
        weeksUntilTurn = 0 // If they are the offender, it's their turn.
      } else {
        // Calculate normal turn distance, ignoring any penalty
        weeksUntilTurn = (personIndex - currentIndex + teamSize) % teamSize
      }

      const theirTurnDate = new Date()
      theirTurnDate.setDate(theirTurnDate.getDate() + weeksUntilTurn * 7)

      // 5. Build the unique message for each person
      let personalStatus = ''
      if (weeksUntilTurn === 0) {
        personalStatus = `It's your turn this week, ${person.name}!`
        if (isPenaltyWeek) {
          personalStatus += ` This is week ${
            3 - penaltyBox.weeksRemaining
          } of 3 for your penalty.`
        }
      } else if (weeksUntilTurn === 1 && !isPenaltyWeek) {
        personalStatus = `Hi ${person.name}, your turn is next week.`
      } else {
        personalStatus = `${person.name}, your next turn is on ${formatDate(
          theirTurnDate
        )}, in ${weeksUntilTurn} weeks.`
      }

      const messageBody =
        `Trash Duty:\n\n` +
        `1. This week (${formatDate(thisWeekDate)}): ${personOnDuty.name}\n` +
        `2. Next week (${formatDate(nextWeekDate)}): ${
          nextPersonInRotation.name
        }\n\n` +
        `${personalStatus}`

      // 6. Send the message
      await sendSms(env, person.phone, messageBody)
    }
  },

  /**
   * This function acts as our API. It listens for requests from the frontend dashboard.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    // Respond to pre-flight CORS requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    // Endpoint to get schedule data for the dashboard
    if (url.pathname === '/schedule') {
      const team = await env.ROTATION_DB.get('TEAM_MEMBERS', 'json')
      const currentIndex = parseInt(
        (await env.ROTATION_DB.get('CURRENT_INDEX')) || '0'
      )
      const penaltyBox =
        (await env.ROTATION_DB.get('PENALTY_BOX', 'json')) || {}
      const teamSize = team.length

      let onDutyName
      let penaltyInfo = {}

      if (penaltyBox.weeksRemaining > 0) {
        onDutyName = team[penaltyBox.offenderIndex].name
        penaltyInfo = { weeksRemaining: penaltyBox.weeksRemaining }
      } else {
        onDutyName = team[currentIndex].name
      }

      const lastWeekIndex = (currentIndex - 1 + teamSize) % teamSize
      const lastWeekName = team[lastWeekIndex].name

      // Create a list of the next 3 people in the normal rotation
      const upcoming = [
        team[(currentIndex + 1) % teamSize].name,
        team[(currentIndex + 2) % teamSize].name,
        team[(currentIndex + 3) % teamSize].name,
      ]

      const responseData = {
        onDuty: onDutyName,
        lastWeek: lastWeekName,
        upcoming: upcoming,
        penaltyInfo: penaltyInfo,
      }

      return new Response(JSON.stringify(responseData), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Endpoint to report a missed duty
    if (url.pathname === '/report' && request.method === 'POST') {
      const teamSize = (await env.ROTATION_DB.get('TEAM_MEMBERS', 'json'))
        .length
      const currentIndex = parseInt(
        (await env.ROTATION_DB.get('CURRENT_INDEX')) || '0'
      )

      // The offender is the person from *last week* relative to the current index
      const offenderIndex = (currentIndex - 1 + teamSize) % teamSize

      const penalty = {
        offenderIndex: offenderIndex,
        weeksRemaining: 3,
      }
      await env.ROTATION_DB.put('PENALTY_BOX', JSON.stringify(penalty))

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

// --- HELPER FUNCTIONS ---

/**
 * Sends an SMS using the Twilio API.
 * @param {object} env - The environment object containing secrets.
 * @param {string} to - The recipient's phone number in E.164 format.
 * @param {string} body - The text message content.
 */
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

/**
 * Formats a Date object into a readable string like "Oct 1".
 * @param {Date} date - The date to format.
 * @returns {string} - The formatted date string.
 */
function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
