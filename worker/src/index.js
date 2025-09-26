const PENALTY_LENGTH = 3

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
    const rawPenaltyBox = await rotationDb.get('PENALTY_BOX', 'json')
    const teamSize = team.length

    // 2. Validate the stored penalty state before using it.
    let penaltyBox = null
    let penaltyOffender
    let penaltyWeeks = 0
    if (rawPenaltyBox) {
      const offenderIndex = Number.isInteger(rawPenaltyBox.offenderIndex)
        ? rawPenaltyBox.offenderIndex
        : undefined
      const weeksRemaining = Number.isInteger(rawPenaltyBox.weeksRemaining)
        ? rawPenaltyBox.weeksRemaining
        : 0
      if (
        offenderIndex !== undefined &&
        offenderIndex >= 0 &&
        offenderIndex < teamSize
      ) {
        penaltyOffender = team[offenderIndex]
        penaltyWeeks = Math.max(0, weeksRemaining)
        if (penaltyWeeks === 0) {
          // Stale penalty entry from a completed cycle—clean it up.
          await rotationDb.delete('PENALTY_BOX')
        } else {
          penaltyBox = { offenderIndex, weeksRemaining: penaltyWeeks }
        }
      } else {
        // Invalid penalty (probably team edited); clean it up so the worker can recover.
        await rotationDb.delete('PENALTY_BOX')
      }
    }

    // 3. IMPORTANT: Update the state for the NEW week *first*
    let activePenalty = null
    if (penaltyBox && penaltyWeeks > 0) {
      const remainingAfterThisWeek = Math.max(0, penaltyWeeks - 1)
      activePenalty = {
        offenderIndex: penaltyBox.offenderIndex,
        offender: penaltyOffender,
        remainingAfterThisWeek,
      }

      await rotationDb.put(
        'PENALTY_BOX',
        JSON.stringify({
          offenderIndex: penaltyBox.offenderIndex,
          weeksRemaining: remainingAfterThisWeek,
        })
      )
    } else {
      currentIndex = (currentIndex + 1) % teamSize
      await rotationDb.put('CURRENT_INDEX', currentIndex.toString())
    }

    // 3. Determine who is on duty for THIS week and NEXT week based on the new state
    let personOnDuty
    let nextPersonUp

    if (activePenalty && activePenalty.offender) {
      personOnDuty = activePenalty.offender
      if (activePenalty.remainingAfterThisWeek >= 1) {
        nextPersonUp = personOnDuty
      } else {
        nextPersonUp = team[currentIndex]
      }
    } else {
      personOnDuty = team[currentIndex]
      nextPersonUp = team[(currentIndex + 1) % teamSize]
    }

    // 4. Loop through and send personalized, grammar-aware SMS messages
    const sendQueue = []

    for (const [personIndex, person] of team.entries()) {
      let personalStatus = ''
      const thisWeekDate = new Date()

      if (activePenalty && activePenalty.offender) {
        if (personIndex === activePenalty.offenderIndex) {
          personalStatus = `⚠️ ${
            person.name
          }, you are on Trash Duty.\nThis is week ${
            PENALTY_LENGTH - activePenalty.remainingAfterThisWeek
          } of ${PENALTY_LENGTH} for your penalty.`
        } else {
          const normalWeeksUntilTurn =
            (personIndex - currentIndex + teamSize) % teamSize
          const weeksUntilTurn =
            normalWeeksUntilTurn + activePenalty.remainingAfterThisWeek + 1
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

      sendQueue.push(sendSms(env, person.phone, messageBody))
    }

    if (sendQueue.length > 0) {
      const results = await Promise.allSettled(sendQueue)
      const failures = results.filter((result) => {
        if (result.status === 'rejected') return true
        return result.value && result.value.ok === false
      })
      if (failures.length > 0) {
        console.error(
          `Scheduled run completed with ${failures.length} Twilio delivery issue(s).`
        )
      }
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
        const offenderValid =
          offenderIndex !== undefined &&
          offenderIndex >= 0 &&
          offenderIndex < teamSize
        const futureWeeks = Number.isInteger(rawPenaltyBox.weeksRemaining)
          ? Math.max(0, rawPenaltyBox.weeksRemaining)
          : 0

        if (offenderValid) {
          const offender = team[offenderIndex]
          const penaltyActive =
            offender && (offenderIndex === currentIndex || futureWeeks > 0)
          const penaltyPending = offender && !penaltyActive && futureWeeks > 0

          if (penaltyActive || penaltyPending) {
            const displayWeeksRemaining = penaltyActive
              ? futureWeeks + 1
              : futureWeeks
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
              rawWeeksRemaining: futureWeeks,
              weekString,
              isActive: penaltyActive,
              startsNextRotation: penaltyPending,
              bannerText,
            }

            if (penaltyPending) {
              lastWeekName = offender.name
            } else if (penaltyActive) {
              onDutyName = offender.name
              lastWeekName = offender.name
            }
          }
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
      const existingFutureWeeks = Number.isInteger(
        existingPenalty.weeksRemaining
      )
        ? Math.max(0, existingPenalty.weeksRemaining)
        : 0
      const hasActivePenalty =
        Number.isInteger(existingPenalty.offenderIndex) &&
        existingFutureWeeks > 0
      // If a penalty is active we penalize the same offender again; otherwise fall back to
      // “last week’s” person based on rotation order.
      const offenderIndex = hasActivePenalty
        ? existingPenalty.offenderIndex
        : (currentIndex - 1 + teamSize) % teamSize

      if (
        hasActivePenalty &&
        existingPenalty.offenderIndex === offenderIndex &&
        existingFutureWeeks >= PENALTY_LENGTH - 1
      ) {
        const offender = teamData[offenderIndex]
        console.info(
          `Penalty report ignored: ${offender.name} already has ${existingFutureWeeks} future weeks queued.`
        )
        const responseData = {
          message: `${offender.name} already has a penalty in progress. No changes recorded.`,
        }
        return new Response(JSON.stringify(responseData), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const penalty = {
        offenderIndex: offenderIndex,
        weeksRemaining: Math.max(0, PENALTY_LENGTH - 1),
      }
      await rotationDb.put('PENALTY_BOX', JSON.stringify(penalty))
      await rotationDb.put('CURRENT_INDEX', offenderIndex.toString())

      const offender = teamData[offenderIndex]
      if (offender && offender.name) {
        console.info(
          `Penalty activated for ${offender.name}. Future penalty weeks queued: ${penalty.weeksRemaining}`
        )
        const penaltyMessage =
          `⚠️ Penalty filed: ${offender.name} missed trash duty.` +
          `\n${offender.name} is now assigned for the next ${PENALTY_LENGTH} weeks.` +
          `\n\nCheck the schedule: https://trashbot.kwon.ai`

        const recipients = teamData.filter(
          (member) => member && typeof member.phone === 'string' && member.phone
        )

        const alertResults = await Promise.allSettled(
          recipients.map((member) => sendSms(env, member.phone, penaltyMessage))
        )
        const alertFailures = alertResults.filter((result) => {
          if (result.status === 'rejected') return true
          return result.value && result.value.ok === false
        })
        if (alertFailures.length > 0) {
          console.error(
            `Penalty alert failed for ${alertFailures.length} teammate(s).`
          )
        }
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
      return { ok: false, to, error: errorData.message }
    } else {
      console.log(`Message sent successfully to ${to}`)
      return { ok: true, to }
    }
  } catch (error) {
    console.error(`Failed to send message to ${to}:`, error)
    return { ok: false, to, error: error?.message || 'unknown error' }
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
