const { toOpenAIError } = require('./errors')
const {
  restoreMcpInjections,
  showAvailableMcpTags,
  handleSkill,
} = require('../lib/engine/triggers')

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

/**
 * Shared pipeline: restore MCP injections, format prompt, build prompt,
 * show available MCP tags on new sessions, and handle skills.
 * Returns { prompt } — if a skill was triggered the response is already
 * ended by handleSkill and the caller should return early.
 *
 * @param {object} compiler
 * @param {object} parser
 * @param {object} session
 * @param {Array}  messages
 * @param {Array}  tools
 * @param {object} req
 * @returns {Promise<{prompt: string, handled: boolean}>}
 */
async function setupCompilerPipeline(compiler, parser, session, messages, tools, req) {
  restoreMcpInjections(session, compiler.tools, tools)

  const { prompt, skill } = await compiler.formatPrompt(messages, parser)

  if (skill) {
    handleSkill(skill, req, parser)
    return { prompt: '', handled: true }
  }

  const built = compiler.buildPrompt(prompt, parser)

  if (parser.isNewSession) {
    showAvailableMcpTags(tools, parser)
  }

  return { prompt: built, handled: false }
}

module.exports = { validateMessages, handleRouteError, setupCompilerPipeline }
