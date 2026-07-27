/**
 * Minimal, non-agentic prompt builder for ephemeral utility calls — no
 * instructions.md injection, no skill matching, no tool grammar, no MCP tag
 * scanning. Just role-tagged message content joined into a flat prompt, the
 * same shape a plain (non-tool-calling) completion would expect.
 *
 * @param {Array} messages - req.body.messages
 * @returns {string}
 */
function buildRawPrompt(messages) {
  return (messages || [])
    .map((m) => {
      const role = (m.role || 'user').toUpperCase()
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      return `${role}: ${content}`
    })
    .join('\n\n')
}

module.exports = { buildRawPrompt }
