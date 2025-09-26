export default {
  /**
   * This is the main automated function. It runs on a Cron Trigger (e.g., once a week).
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
    const penaltyBox = (await env.ROTATION_DB.get('PENALTY_BOX', 'json')) || {}
    const teamSize = team.length

    // --- THE CRUCIAL CHANGE: UPDATE THE STATE FOR THE NEW WEEK *FIRST* ---
    const isPenaltyActive =
      penaltyBox.weeksRemaining && penaltyBox.weeksRemaining > 0

    if (isPenaltyActive) {
      // If a penalty is active, we just decrement the weeks. The index does not change.
      penaltyBox.weeksRemaining--
      await env.ROTATION_DB.put('PENALTY_BOX', JSON.stringify(penaltyBox))
    } else {
      // If there is no penalty, we advance the rotation index. This is the official "changing of the guard".
      currentIndex = (currentIndex + 1) % teamSize
      await env.ROTATION_DB.put('CURRENT_INDEX', currentIndex.toString())
    }
    // --- END OF STATE UPDATE ---

    // Now that the state is updated, the rest of the function reports on this NEW state.

    let personOnDuty
    let nextPersonUp

    if (isPenaltyActive) {
      personOnDuty = team[penaltyBox.offenderIndex]
      if (penaltyBox.weeksRemaining >= 1) {
        // Use >=1 because we already decremented
        nextPersonUp = personOnDuty // Penalty continues
      } else {
        nextPersonUp = team[currentIndex] // Penalty ends, normal rotation resumes next
      }
    } else {
      personOnDuty = team[currentIndex] // Normal rotation
      nextPersonUp = team[(currentIndex + 1) % teamSize]
    }

    // The rest of the message generation logic is identical, as it correctly reads the variables.
    for (const [personIndex, person] of team.entries()) {
      let personalStatus = ''
      const thisWeekDate = new Date()

      if (isPenaltyActive) {
        if (personIndex === penaltyBox.offenderIndex) {
          personalStatus = `⚠️ ${
            person.name
          }, you are on Trash Duty.\nThis is week ${
            3 - penaltyBox.weeksRemaining
          } of 3 for your penalty.`
        } else {
          const normalWeeksUntilTurn =
            (personIndex - currentIndex + teamSize) % teamSize
          const weeksUntilTurn =
            normalWeeksUntilTurn + penaltyBox.weeksRemaining + 1 // +1 because the penalty is still finishing
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

  /**
   * This function acts as our API. It listens for requests from the frontend dashboard.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', // This is the crucial permission header
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    if (url.pathname === '/schedule') {
      const team = await env.ROTATION_DB.get('TEAM_MEMBERS', 'json')
      const currentIndex = parseInt(
        (await env.ROTATION_DB.get('CURRENT_INDEX')) || '0'
      )
      const penaltyBox =
        (await env.ROTATION_DB.get('PENALTY_BOX', 'json')) || {}
      const teamSize = team.length

      let onDutyName
      let lastWeekName
      let penaltyInfo = {}
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

      // ** THE FIX IS HERE: We are adding the `headers` object back to the response **
      return new Response(JSON.stringify(responseData), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (url.pathname === '/report' && request.method === 'POST') {
      const teamSize = (await env.ROTATION_DB.get('TEAM_MEMBERS', 'json'))
        .length
      const currentIndex = parseInt(
        (await env.ROTATION_DB.get('CURRENT_INDEX')) || '0'
      )
      const offenderIndex = (currentIndex - 1 + teamSize) % teamSize

      const penalty = { offenderIndex: offenderIndex, weeksRemaining: 3 }
      await env.ROTATION_DB.put('PENALTY_BOX', JSON.stringify(penalty))

      const responseData = {
        message:
          'Penalty has been recorded. The schedule will update on the next rotation.',
      }

      // ** THE FIX IS ALSO HERE: Adding headers to the report response **
      return new Response(JSON.stringify(responseData), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response('Not Found', { status: 404 })
  },
}

// --- HELPER FUNCTIONS --- (No changes below this line)

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

function formatDate(date) {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}
