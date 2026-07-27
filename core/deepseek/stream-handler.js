const { readSSE } = require('../../utils/sse-reader')
const RETRY_REASONS = {
  'Messages too frequent. Try again later.': true,
  'Server is busy. Try again later.': true,
}

/**
 * DeepSeek SSE Stream Handler
 *
 * DeepSeek SSE formats:
 *   data: {"o":"SET","v":"FINISHED"}         → stream complete
 *   data: {"o":"BATCH","v":[...]}            → token usage
 *   data: {"v":{"response":{...}}}           → message delta with metadata
 *   data: {"v":"text"}                       → bare text delta
 */
function streamHandler(stream, session, parser, retry) {
  let cancelled = false
  let finished = false

  const doRetry = (reason) => {
    cancelled = true
    console.error(`[DeepSeek] Stream error: ${reason}`)
    parser.scan(`\n\n⚠ Stream error: ${reason}\n`)

    if (RETRY_REASONS[reason] && retry) {
      console.debug('[DeepSeek] Retrying...')
      try {
        stream.destroy()
      } catch {}
      retry()
        .then((newStream) => {
          streamHandler(newStream, session, parser, retry)
        })
        .catch((err) => {
          console.error(`[DeepSeek] Retry failed: ${err.message}`)
          parser.sendFinalChunk()
        })
      return
    }
    parser.sendFinalChunk()
  }

  const onData = (data) => {
    if (cancelled) return

    if (data.type === 'error') {
      doRetry(data.content)
      return
    } else if (data.o === 'SET') {
      if (data.v === 'FINISHED') {
        finished = true
        parser.sendFinalChunk()
      }
    } else if (data.o === 'BATCH') {
      const usageEntry = data.v?.find((e) => e.p === 'accumulated_token_usage')
      const statusEntry = data.v?.find((e) => e.p === 'quasi_status')
      if (usageEntry) {
        parser.tokenUsage.prompt_tokens = 0
        parser.tokenUsage.completion_tokens = usageEntry.v
        parser.tokenUsage.total_tokens =
          parser.tokenUsage.completion_tokens + parser.tokenUsage.prompt_tokens
        console.debug(`[DeepSeek] Tokens: ${usageEntry.v} (status: ${statusEntry?.v ?? '-'})`)
      }
    } else {
      const response = data.v?.response
      if (response) {
        session.parentMessageId = response.message_id
        session.lastUsed = new Date().toISOString()
        parser.scan(response.fragments[0]?.content || '')
      } else if (typeof data.v === 'string') {
        parser.scan(data.v)
      }
    }
  }

  const onDone = () => {
    if (cancelled) return
    if (finished) return
    doRetry('stream closed unexpectedly')
  }

  readSSE(stream, { onData, onDone, onError: (e) => parser.onError(e) })
}

module.exports = { streamHandler }
