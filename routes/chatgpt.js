const express = require('express')

const { StreamPipeline } = require('../engine/pipeline')
const { ChatGPTAPI } = require('../core/chatgpt/api')
const { chatgptStreamHandler } = require('../core/chatgpt/stream-handler')
const { acquireSlot } = require('../utils/rate-limiter')
const { validateMessages } = require('../utils/route-helpers')
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

    StreamPipeline.setSSEHeaders(res)
    const pipeline = new StreamPipeline(res, session, 'chatgpt', req.ide)

    const attachments = []
    pipeline.bindUploader(chatgptApi, attachments)

    const { prompt, handled } = await pipeline.setup(messages, tools, req)
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

      chatgptStreamHandler(stream, session, pipeline)
    } catch (error) {
      return pipeline.onError(error)
    }
  })

  return router
}

module.exports = { buildChatGPTRouter }
