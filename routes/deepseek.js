const express = require('express')

const ToolCompiler = require('../lib/engine')
const { DeepSeekAPI } = require('../core/deepseek/api')
const { streamHandler } = require('../core/deepseek/stream-handler')
const { acquireSlot } = require('../utils/rate-limiter')
const {
  validateMessages,
  handleRouteError,
  setupCompilerPipeline,
} = require('../utils/route-helpers')
const { tryEmitTitle } = require('../utils/is-title-gen')

const deepseekApi = new DeepSeekAPI()

async function buildDeepSeekRouter(parsedFetch, session) {
  console.debug('[Deepseek] Initializing from parsed capture JSON')
  await initDeepSeekAPI(session, parsedFetch.headers)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], tools } = req.body

    if (tryEmitTitle(req, res, 'deepseek', session)) return

    if (!validateMessages(messages, res)) return

    const compiler = new ToolCompiler(req.ide, 'deepseek')
    ToolCompiler.setSSEHeaders(res)
    const parser = compiler.getParser(res, session)
    const modelType = parser.isNewSession ? session.model || 'expert' : null

    // Extract and upload files from messages
    const fileIds = []
    parser.bindUploader(deepseekApi, fileIds)

    const { prompt, handled } = await setupCompilerPipeline(
      compiler,
      parser,
      session,
      messages,
      tools,
      req,
    )
    if (handled) return

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

      streamHandler(deepseekStream, session, parser, retry)
    } catch (error) {
      return handleRouteError(error, parser)
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
