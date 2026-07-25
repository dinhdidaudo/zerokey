const express = require('express')

const ToolCompiler = require('../lib/engine')
const { ClaudeAPI } = require('../core/claude/api')
const { claudeStreamHandler } = require('../core/claude/stream-handler')
const { setClaudeInstructions } = require('../core/claude/set-instructions')
const { acquireSlot } = require('../utils/rate-limiter')
const { validateMessages, handleRouteError } = require('../utils/route-helpers')
const { tryEmitTitle } = require('../utils/is-title-gen')
const { handleSkill } = require('../lib/engine/triggers')

const claudeApi = new ClaudeAPI()

async function buildClaudeRouter(parsedFetch, session, userData = null) {
  console.debug('[Claude] Initializing from parsed capture JSON')
  await claudeApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], reasoning_effort: reasoningEffort = null } = req.body

    if (tryEmitTitle(req, res, 'claude', session)) return

    const toolCalling = session.toolCalling ?? true
    const model = session.model

    if (!validateMessages(messages, res)) return

    const compiler = new ToolCompiler(req.ide, 'claude')
    ToolCompiler.setSSEHeaders(res)
    const parser = compiler.getParser(res, session)

    if (userData?.waitUntil && userData.waitUntil > Date.now()) {
      emitLimitResponse(
        parser,
        userData.waitUntil,
        `This user's usage quota is still over its limit`,
      )
      return
    }

    const fileIds = []
    const uploadFile = async (f) => fileIds.push(await claudeApi.uploadFile(f))
    const isNewSession = session.parentMessageId == null

    const { dynamicGrammar } = compiler.syncDynamicTools(req.body.tools || [], session)

    const { prompt, skill } = await compiler.formatPrompt(
      messages,
      isNewSession,
      uploadFile,
      session,
    )

    if (skill) return handleSkill(skill, req, dynamicGrammar, parser)

    if (isNewSession) {
      await setClaudeInstructions(claudeApi, userData, dynamicGrammar, toolCalling)
    }

    await acquireSlot('Claude')

    try {
      const { stream, chatSessionId } = await claudeApi.chatCompletion(
        prompt,
        session.chatSessionId,
        session.parentMessageId,
        model,
        [],
        fileIds,
        reasoningEffort,
      )

      if (chatSessionId && !session.chatSessionId) {
        session.chatSessionId = chatSessionId
      }

      await claudeStreamHandler(stream, session, parser, async (limitReached) => {
        if (limitReached?.resets_at) {
          userData.waitUntil = limitReached.resets_at * 1000
          userData.waitReason = 'Claude rate limit'

          const resetTime = new Date(userData.waitUntil).toLocaleTimeString()
          const mins = Math.max(1, Math.ceil((userData.waitUntil - Date.now()) / 60000))
          const overUtilized = limitReached.util >= 1.0

          if (overUtilized) {
            console.warn(`[Claude] ⚠ Usage at ${limitReached.pct} — over limit, skipping summary`)
            emitLimitResponse(
              parser,
              userData.waitUntil,
              `This user's usage quota has already been reached (${limitReached.pct})`,
            )
            return
          }

          console.warn(`[Claude] ⚠ Usage at ${limitReached.pct} — requesting summary`)

          try {
            const summaryPrompt = `Please write a concise but complete summary of this entire conversation — so it can be pasted into a fresh session to resume work seamlessly.`
            const { stream: summaryStream } = await claudeApi.chatCompletion(
              summaryPrompt,
              session.chatSessionId,
              session.parentMessageId,
              model,
              [],
            )

            parser.scan('\n\n````text\n')
            await claudeStreamHandler(summaryStream, session, parser, () => {
              parser.scan('\n````')
              parser.scan(limitMessageText(resetTime, mins))
              parser.sendFinalChunk()
            })
          } catch (summaryErr) {
            console.error(`[Claude] Summary failed: ${summaryErr.message}`)
            emitLimitResponse(
              parser,
              userData.waitUntil,
              `Could not generate a conversation summary — usage is already over the limit (${limitReached.pct}), so this request was rejected too`,
            )
          }

          return
        }
      })
    } catch (error) {
      console.error(`[Claude] Route error: ${error.message}`)

      try {
        const raw = JSON.parse(error.message)
        const payload = raw?.error?.message ? JSON.parse(raw.error.message) : null
        const limit = payload?.resolved?.limit
        const reset = limit?.resets_at || payload?.windows?.['5h']?.resets_at || payload?.resetsAt

        if (reset) {
          userData.waitUntil = typeof reset === 'number' ? reset * 1000 : new Date(reset).getTime()
          userData.waitReason = limit?.title || payload?.notice?.title || 'Claude rate limit'
        }

        if (payload?.resolved?.status === 'exceeded') {
          emitLimitResponse(parser, userData.waitUntil, `This user's usage quota has been reached`)

          return
        }
      } catch {}

      return handleRouteError(error, parser)
    }
  })

  return router
}

function limitMessageText(resetTime, mins) {
  return `\n⟦ask¦question=This Claude session has reached its usage limit. It resets at ${resetTime} (~${mins} min). What would you like to do?¦option=Switch to another Claude user¦default=true¦option=Switch to another provider¦option=Please Continue⟧`
}

function computeReset(waitUntilMs) {
  const resetTime = new Date(waitUntilMs).toLocaleTimeString()
  const mins = Math.max(1, Math.ceil((waitUntilMs - Date.now()) / 60000))
  return { resetTime, mins }
}

function emitLimitResponse(parser, waitUntilMs, prefix) {
  const { resetTime, mins } = computeReset(waitUntilMs)

  parser.scan(`\n\n⚠ ${prefix} — it needs ~${mins} min to reset at ${resetTime}.\n`)
  parser.scan(limitMessageText(resetTime, mins))
  parser.sendFinalChunk()
}

module.exports = { buildClaudeRouter }
