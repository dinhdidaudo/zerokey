const express = require('express')

const ToolCompiler = require('../lib/engine')
const { ChatGPTAPI } = require('../core/chatgpt/api')
const { chatgptStreamHandler } = require('../core/chatgpt/stream-handler')
const { acquireSlot } = require('../utils/rate-limiter')
const {
  validateMessages,
  handleRouteError,
  setupCompilerPipeline,
} = require('../utils/route-helpers')
const { tryEmitTitle } = require('../utils/is-title-gen')

const chatgptApi = new ChatGPTAPI()

async function buildChatGPTRouter(parsedFetch, session, _userData = null) {
  console.debug('[ChatGPT] Initializing from parsed capture JSON')
  await chatgptApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [], tools } = req.body

    if (tryEmitTitle(req, res, 'chatgpt', session)) return

    const model = session.model || 'auto'
    if (!validateMessages(messages, res)) return

    const compiler = new ToolCompiler(req.ide, 'chatgpt')
    ToolCompiler.setSSEHeaders(res)
    const parser = compiler.getParser(res, session)

    const attachments = []
    parser.bindUploader(chatgptApi, attachments)

    const { prompt, handled } = await setupCompilerPipeline(
      compiler,
      parser,
      session,
      messages,
      tools,
      req,
    )
    if (handled) return

    await acquireSlot('ChatGPT')

    try {
      const stream = await chatgptApi.chatCompletion(
        prompt,
        session.chatSessionId,
        session.parentMessageId,
        model,
        attachments,
      )

      chatgptStreamHandler(stream, session, parser)
    } catch (error) {
      return handleRouteError(error, parser)
    }
  })

  return router
}

module.exports = { buildChatGPTRouter }
