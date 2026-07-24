const express = require('express')

const ToolCompiler = require('../lib/engine')
const { DeepSeekAPI } = require('../core/deepseek/api')
const { streamHandler } = require('../core/deepseek/stream-handler')
const { acquireSlot } = require('../utils/rate-limiter')
const { setSSEHeaders } = require('../utils/stream-helpers')
const { validateMessages, handleRouteError } = require('../utils/route-helpers')
const { tryEmitTitle } = require('../utils/is-title-gen')

const deepseekApi = new DeepSeekAPI()

async function buildDeepSeekRouter(parsedFetch, session) {
  console.debug('[Deepseek] Initializing from parsed capture JSON')
  await initDeepSeekAPI(session, parsedFetch.headers)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [] } = req.body

    if (tryEmitTitle(req, res, 'deepseek', session)) return

    const toolCalling = session.toolCalling ?? true

    if (!validateMessages(messages, res)) return

    // Extract and upload files from messages
    const fileIds = []
    const uploadFile = async (f) => fileIds.push(await deepseekApi.uploadFile(f))

    const compiler = new ToolCompiler(req.ide, 'deepseek')
    const isNewSession = session.parentMessageId == null
    const modelType = isNewSession ? session.model || 'expert' : null

    const { dynamicGrammar } = compiler.syncDynamicTools(req.body.tools || [], session)

    let { prompt, skill } = await compiler.formatPrompt(messages, isNewSession, uploadFile)

    if (isNewSession) {
      prompt = toolCalling ? compiler.buildPrompt(prompt, dynamicGrammar) : prompt
    }

    setSSEHeaders(res)

    const parser = new ToolCompiler.Stream(res, 'deepseek', compiler, session)

    if (skill) {
      console.info(
        `[DeepSeek] Skill trigger detected (${skill.triggers[0]}) — bypassing provider API`,
      )
      return ToolCompiler.emitAndEnd(res, parser, skill.bpi)
    }

    try {
      await acquireSlot('DeepSeek')
      const deepseekStream = await deepseekApi.chatCompletion(
        session.chatSessionId,
        prompt,
        session.parentMessageId,
        false,
        true,
        modelType,
        fileIds,
      )

      const retry = async () => {
        await acquireSlot('DeepSeek', true)
        return deepseekApi.chatCompletion(
          session.chatSessionId,
          prompt,
          session.parentMessageId,
          false,
          true,
          modelType,
          fileIds,
        )
      }

      streamHandler(res, deepseekStream, session, parser, retry)
    } catch (error) {
      return handleRouteError(error, 'DeepSeek', res, session, parser)
    }
  })

  return router
}

async function initDeepSeekAPI(session, headers) {
  await deepseekApi.initialize(headers)
  console.debug('[DeepSeek] Initialized from capture JSON')

  if (!session) throw new Error('No session provided')

  if (session.chatSessionId) {
    // console.debug(`[DeepSeek] Session: "${session.name}" (${session.chatSessionId})`)
    return
  }

  const chatSessionId = await deepseekApi.createChatSession()
  session.chatSessionId = chatSessionId
  // console.success(`[DeepSeek] Session created: "${session.name}" (${chatSessionId})`)
}

module.exports = { buildDeepSeekRouter, initDeepSeekAPI }
