const { readSSE } = require('../../utils/sse-reader')
const { setupStreamHandlers } = require('../../utils/stream-helpers')

/**
 * DeepSeek SSE Stream Handler
 *
 * DeepSeek SSE formats:
 *   data: {"o":"SET","v":"FINISHED"}         → stream complete
 *   data: {"o":"BATCH","v":[...]}            → token usage
 *   data: {"v":{"response":{...}}}           → message delta with metadata
 *   data: {"v":"text"}                       → bare text delta
 */
function streamHandler(res, stream, session, parser, retry) {
  const tokenUsage = {}
  const { sendFinalChunk, onError } = setupStreamHandlers(
    res,
    session,
    parser,
    'DeepSeek',
    tokenUsage,
  )
  let cancelled = false
  let finished = false

  const doRetry = (reason) => {
    cancelled = true
    console.error(`[DeepSeek] Stream error: ${reason}`)
    parser.scan(`\n\n⚠ Stream error: ${reason}`)

    if (retry) {
      console.debug('[DeepSeek] Retrying...')
      try {
        stream.destroy()
      } catch {}
      retry()
        .then((newStream) => {
          streamHandler(res, newStream, session, parser, retry)
        })
        .catch((err) => {
          console.error(`[DeepSeek] Retry failed: ${err.message}`)
          sendFinalChunk()
        })
      return
    }
    sendFinalChunk()
  }

  const onData = (data) => {
    if (cancelled) return

    if (data.type === 'error') {
      doRetry(data.content)
      return
    } else if (data.o === 'SET') {
      if (data.v === 'FINISHED') {
        finished = true
        sendFinalChunk()
      }
    } else if (data.o === 'BATCH') {
      const usageEntry = data.v?.find((e) => e.p === 'accumulated_token_usage')
      const statusEntry = data.v?.find((e) => e.p === 'quasi_status')
      if (usageEntry) {
        tokenUsage.prompt_tokens = 0
        tokenUsage.completion_tokens = usageEntry.v
        tokenUsage.total_tokens = tokenUsage.completion_tokens + tokenUsage.prompt_tokens
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

  readSSE(stream, { onData, onDone, onError })
}

module.exports = { streamHandler }
