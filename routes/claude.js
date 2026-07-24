const express = require('express')
const { ClaudeAPI } = require('../core/claude/api')
const { claudeStreamHandler } = require('../core/claude/stream-handler')
const { toOpenAIError } = require('../utils/errors')
const ToolCompiler = require('../lib/engine')
const { setClaudeInstructions } = require('../core/claude/set-instructions')
const { extractFiles, uploadFiles } = require('../utils/extract-files')

const claudeApi = new ClaudeAPI()
const { acquireSlot } = require('../utils/rate-limiter')
const { setSSEHeaders, createSendFinalChunk } = require('../utils/stream-helpers')
const { tryEmitTitle } = require('../utils/is-title-gen')

async function buildClaudeRouter(parsedFetch, session, userData = null) {
  console.debug('[Claude] Initializing from parsed capture JSON')
  await claudeApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], reasoning_effort: reasoningEffort = null } = req.body

    if (tryEmitTitle(req, res, 'claude', session)) return

    const toolCalling = session.toolCalling ?? true
    const model = session.model

    if (!messages || messages.length === 0) {
      return res
        .status(400)
        .json(
          toOpenAIError(
            400,
            'messages is required and must be a non-empty array',
            'invalid_request_error',
            'missing_messages',
          ),
        )
    }

    if (userData?.waitUntil && userData.waitUntil > Date.now()) {
      emitLimitResponse(
        res,
        req,
        session,
        {},
        userData.waitUntil,
        `This user's usage quota is still over its limit`,
      )
      return
    }

    const fileIds = []
    const uploadFile = async (f) => fileIds.push(await claudeApi.uploadFile(f))
    const compiler = new ToolCompiler(req.ide, 'claude')
    const isNewSession = session.parentMessageId == null

    const { dynamicGrammar } = compiler.syncDynamicTools(req.body.tools || [], session)

    const { prompt, skill } = await compiler.formatPrompt(messages, isNewSession, uploadFile)

    setSSEHeaders(res)

    const parser = new ToolCompiler.Stream(res, 'claude', compiler, session)

    if (skill) {
      console.info(
        `[Claude] Skill trigger detected (${skill.triggers[0]}) — bypassing provider API`,
      )
      return ToolCompiler.emitSkill(res, parser, skill)
    }

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

      await claudeStreamHandler(
        res,
        stream,
        session,
        parser,
        async (limitReached, sendFinalChunk) => {
          if (limitReached?.resets_at) {
            userData.waitUntil = limitReached.resets_at * 1000
            userData.waitReason = 'Claude rate limit'

            const resetTime = new Date(userData.waitUntil).toLocaleTimeString()
            const mins = Math.max(1, Math.ceil((userData.waitUntil - Date.now()) / 60000))
            const overUtilized = limitReached.util >= 1.0

            if (overUtilized) {
              console.warn(`[Claude] ⚠ Usage at ${limitReached.pct} — over limit, skipping summary`)
              emitLimitResponse(
                res,
                req,
                session,
                { compiler, parser, sendFinalChunk },
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
              await claudeStreamHandler(
                res,
                summaryStream,
                session,
                parser,
                (limitReached, sendFinalChunk) => {
                  parser.scan('\n````')
                  parser.scan(limitMessageText(resetTime, mins))
                  sendFinalChunk()
                },
              )
            } catch (summaryErr) {
              console.error(`[Claude] Summary failed: ${summaryErr.message}`)
              emitLimitResponse(
                res,
                req,
                session,
                { compiler, parser, sendFinalChunk },
                userData.waitUntil,
                `Could not generate a conversation summary — usage is already over the limit (${limitReached.pct}), so this request was rejected too`,
              )
            }

            return
          }
        },
      )
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
          emitLimitResponse(
            res,
            req,
            session,
            { compiler },
            userData.waitUntil,
            (resetTime, mins) => `This user's usage quota has been reached`,
          )

          return
        }
      } catch {}

      const err = toOpenAIError(error, 'Claude')

      if (res.headersSent) {
        const parser = new ToolCompiler.Stream(res, 'claude', compiler, session)
        parser.scan(`\n\n⚠ ${err.error.message}${err.error.action ? ' ' + err.error.action : ''}\n`)
        const sendFinalChunk = createSendFinalChunk(res, session, parser, {})
        sendFinalChunk()
        return
      }

      return res.status(err.error.status || 500).json(err)
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

function emitLimitResponse(res, req, session, ctx, waitUntilMs, prefix) {
  const { resetTime, mins } = computeReset(waitUntilMs)

  if (!res.headersSent) setSSEHeaders(res)
  const compiler = ctx.compiler || new ToolCompiler(req.ide, 'claude')
  const parser = ctx.parser || new ToolCompiler.Stream(res, 'claude', compiler, session)
  const sendFinalChunk = ctx.sendFinalChunk || createSendFinalChunk(res, session, parser, {})

  parser.scan(`\n\n⚠ ${prefix} — it needs ~${mins} min to reset at ${resetTime}.\n`)
  parser.scan(limitMessageText(resetTime, mins))
  sendFinalChunk()
}

module.exports = { buildClaudeRouter }
