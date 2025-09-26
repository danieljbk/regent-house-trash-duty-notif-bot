export default {
  /**
   * SCHEDULED HANDLER
   * Runs on a cron schedule to send notifications.
   */
  async scheduled(event, env, ctx) {
    let rotationDb
    try {
      rotationDb = getRotationDb(env)
    } catch (error) {
      console.error(error.message)
      return
    }

    // 1. Get current state from KV
    const team = await rotationDb.get('TEAM_MEMBERS', 'json')
    if (!team || team.length === 0) {
      console.error('FATAL: Team data is missing or empty.')
      return
    }
    let currentIndex = parseInt((await rotationDb.get('CURRENT_INDEX')) || '0')
    const penaltyBox = (await rotationDb.get('PENALTY_BOX', 'json')) || {}
    const teamSize = team.length

    // 2. IMPORTANT: Update the state for the NEW week *first*
    const isPenaltyActive =
      penaltyBox.weeksRemaining && penaltyBox.weeksRemaining > 0

    if (isPenaltyActive) {
      penaltyBox.weeksRemaining--
      await rotationDb.put('PENALTY_BOX', JSON.stringify(penaltyBox))
    } else {
      currentIndex = (currentIndex + 1) % teamSize
      await rotationDb.put('CURRENT_INDEX', currentIndex.toString())
    }

    // 3. Determine who is on duty for THIS week and NEXT week based on the new state
    let personOnDuty
    let nextPersonUp

    if (isPenaltyActive) {
      personOnDuty = team[penaltyBox.offenderIndex]
      if (penaltyBox.weeksRemaining >= 1) {
        nextPersonUp = personOnDuty
      } else {
        nextPersonUp = team[currentIndex]
      }
    } else {
      personOnDuty = team[currentIndex]
      nextPersonUp = team[(currentIndex + 1) % teamSize]
    }

    // 4. Loop through and send personalized, grammar-aware SMS messages
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
        `https://trashbot.kwon.ai\n\n` +
        `❕ Missed a duty? Report it on the site.`

      await sendSms(env, person.phone, messageBody)
    }
  },

  /**
   * FETCH HANDLER
   * Responds to requests from the website to provide schedule data.
   */
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
        const penaltyBox = (await rotationDb.get('PENALTY_BOX', 'json')) || {}
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

    return new Response('Not Found', { status: 404, headers: corsHeaders })
  },
}

// --- HELPER FUNCTIONS ---

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
