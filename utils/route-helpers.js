const { toOpenAIError } = require('./errors')

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

function handleRouteError(error, parser) {
  const provider = parser.compiler.provider

  console.error(`[${provider}] Route error: ${error.message}`)
  const err = toOpenAIError(error, provider)
  parser.emitAndEnd(`\n\n⚠ ${err.error.message}${err.error.action ? ' ' + err.error.action : ''}\n`)
}

module.exports = { validateMessages, handleRouteError }
