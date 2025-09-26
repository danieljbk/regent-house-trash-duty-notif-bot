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
        const rawPenaltyBox =
          (await rotationDb.get('PENALTY_BOX', 'json')) || {}
        const teamSize = team.length

        // Base indices assume a normal rotation until we prove a penalty overrides it.
        const baseLastWeekIndex = (currentIndex - 1 + teamSize) % teamSize
        let onDutyName = team[currentIndex].name
        let lastWeekName = team[baseLastWeekIndex].name
        let penaltyInfo = {}

        // Parse any stored penalty information and coerce the values we rely on.
        const offenderIndex = Number.isInteger(rawPenaltyBox.offenderIndex)
          ? rawPenaltyBox.offenderIndex
          : undefined
        const weeksRemaining = Number.isInteger(rawPenaltyBox.weeksRemaining)
          ? rawPenaltyBox.weeksRemaining
          : 0
        const offender =
          offenderIndex !== undefined ? team[offenderIndex] : undefined
        const PENALTY_LENGTH = 3
        const penaltyRecorded = offender && weeksRemaining > 0
        // When CURRENT_INDEX already matches the offender we treat the penalty as “active”
        // even if weeksRemaining is still the initial value (meaning we just reassigned them).
        const penaltyIsCurrent =
          penaltyRecorded && offenderIndex === currentIndex
        const penaltyActive =
          penaltyRecorded &&
          (weeksRemaining < PENALTY_LENGTH || penaltyIsCurrent)
        const penaltyPending = penaltyRecorded && !penaltyActive

        if (penaltyPending || penaltyActive) {
          const displayWeeksRemaining = penaltyActive
            ? weeksRemaining + 1
            : weeksRemaining
          const weekString = 
            displayWeeksRemaining === 1 ? 'week' : 'weeks'
          let bannerText = ''

          if (penaltyActive) {
            bannerText = `PENALTY ACTIVE: ${offender.name} has ${displayWeeksRemaining} ${weekString} remaining. The normal rotation is paused.`
          } else {
            bannerText = `Penalty recorded: ${offender.name} owes ${displayWeeksRemaining} ${weekString}. The rotation will pause after this week.`
          }

          penaltyInfo = {
            offenderName: offender.name,
            weeksRemaining: displayWeeksRemaining,
            rawWeeksRemaining: weeksRemaining,
            weekString,
            isActive: penaltyActive,
            startsNextRotation: penaltyPending,
            bannerText,
          }
        }

        if (penaltyPending && offender) {
          // Pending means we just recorded the penalty; last week is still the offender.
          lastWeekName = offender.name
        } else if (penaltyActive && offender) {
          // Active means offender owns the present slot and we want both cards to reflect it.
          onDutyName = offender.name
          lastWeekName = offender.name
        }

        const responseData = {
          onDuty: onDutyName,
          lastWeek: lastWeekName,
          team: team,
          currentIndex: currentIndex,
          penaltyBox: rawPenaltyBox,
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
      // Determine if a penalty is already active so we can decide who actually missed.
      const existingPenalty =
        (await rotationDb.get('PENALTY_BOX', 'json')) || {}
      const hasActivePenalty =
        Number.isInteger(existingPenalty.offenderIndex) &&
        Number.isInteger(existingPenalty.weeksRemaining) &&
        existingPenalty.weeksRemaining > 0
      // If a penalty is active we penalize the same offender again; otherwise fall back to
      // “last week’s” person based on rotation order.
      const offenderIndex = hasActivePenalty
        ? existingPenalty.offenderIndex
        : (currentIndex - 1 + teamSize) % teamSize

      const penalty = { offenderIndex: offenderIndex, weeksRemaining: 3 }
      await rotationDb.put('PENALTY_BOX', JSON.stringify(penalty))
      await rotationDb.put('CURRENT_INDEX', offenderIndex.toString())

      const offender = teamData[offenderIndex]
      if (offender && offender.name) {
        const penaltyMessage =
          `⚠️ Penalty filed: ${offender.name} missed trash duty.` +
          `\n${offender.name} is now assigned for the next 3 weeks.` +
          `\n\nCheck the schedule: https://trashbot.kwon.ai`

        const recipients = teamData.filter(
          (member) => member && typeof member.phone === 'string' && member.phone
        )

        await Promise.allSettled(
          recipients.map((member) => sendSms(env, member.phone, penaltyMessage))
        )
      }

      const responseData = {
        message:
          'Penalty has been recorded. The offender is now on duty for the next three weeks.',
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
