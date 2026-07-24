const { toOpenAIError } = require('./errors')
const { createSendFinalChunk } = require('./stream-helpers')

function validateMessages(messages, res) {
  if (!messages || messages.length === 0) {
    res
      .status(400)
      .json(
        toOpenAIError(
          400,
          'messages is required and must be a non-empty array',
          'invalid_request_error',
          'missing_messages',
        ),
      )
    return false
  }
  return true
}

function handleRouteError(error, provider, res, session, parser) {
  console.error(`[${provider}] Route error: ${error.message}`)
  const err = toOpenAIError(error, provider)

  if (res.headersSent) {
    parser.scan(`\n\n⚠ ${err.error.message}${err.error.action ? ' ' + err.error.action : ''}\n`)
    const sendFinalChunk = createSendFinalChunk(res, session, parser, {})
    sendFinalChunk()
    return
  }

  res.status(err.error.status || 500).json(err)
}

module.exports = { validateMessages, handleRouteError }
