const express = require('express')

const ToolCompiler = require('../lib/engine')
const instructions = require('../lib/engine/instructions')
const { ChatGPTAPI } = require('../core/chatgpt/api')
const { chatgptStreamHandler } = require('../core/chatgpt/stream-handler')
const { acquireSlot } = require('../utils/rate-limiter')
const { validateMessages, handleRouteError } = require('../utils/route-helpers')
const { tryEmitTitle } = require('../utils/is-title-gen')
const { handleSkill } = require('../lib/engine/triggers')

const chatgptApi = new ChatGPTAPI()

async function buildChatGPTRouter(parsedFetch, session, _userData = null) {
  console.debug('[ChatGPT] Initializing from parsed capture JSON')
  await chatgptApi.initializeFromJSON(parsedFetch)

  const router = express.Router()

  router.post('/', async (req, res) => {
    const { messages = [] } = req.body

    if (tryEmitTitle(req, res, 'chatgpt', session)) return

    const toolCalling = session.toolCalling ?? true
    const model = session.model || 'auto'
    if (!validateMessages(messages, res)) return

    const attachments = []
    const uploadFile = async (f) => {
      const attachment = await chatgptApi.uploadFile(f)
      attachments.push(attachment)
      return attachment.id
    }
    const compiler = new ToolCompiler(req.ide, 'chatgpt')
    const isNewSession = session.parentMessageId == null

    const { dynamicGrammar } = compiler.syncDynamicTools(req.body.tools || [], session)

    let { prompt, skill } = await compiler.formatPrompt(messages, isNewSession, uploadFile, session)

    ToolCompiler.setSSEHeaders(res)

    const parser = compiler.getParser(res, session)

    if (skill) return handleSkill(skill, req, dynamicGrammar, parser)

    if (isNewSession && toolCalling) {
      // await setChatGPTInstructions(chatgptApi, userData)
      prompt = instructions.getFull() + '\n\n' + dynamicGrammar + '\n\n' + prompt
    }

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
