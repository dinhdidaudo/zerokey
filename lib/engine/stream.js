const BPI = require('./bpi')
const { classifyError } = require('../../utils/errors')

let callCounter = 0

function buildCall(index, tool, funcName, args) {
  callCounter++
  const id = String(callCounter).padStart(4, '0')
  return {
    index,
    id: `call_${id}_${tool}`,
    type: 'function',
    function: {
      name: funcName,
      arguments: JSON.stringify(args),
    },
  }
}

function buildToolDelta(tool_calls) {
  return {
    role: 'assistant',
    content: null,
    tool_calls,
  }
}

const TODO_TOOLS = new Set(['todos_add', 'todos_set'])
function emitToolCalls(compiler, session, payloads, emit) {
  let lastTodoFunc = null

  const tool_calls = payloads
    .flatMap((payload) => {
      const func = compiler.compile(payload, session)
      if (!func) return []
      return Array.isArray(func) ? func : [func]
    })
    .filter((f) => {
      if (TODO_TOOLS.has(f.tool)) {
        lastTodoFunc = f
        return false
      }
      return true
    })
    .map((f, i) => buildCall(i, f.tool, f.name, f.arguments))
    .filter(Boolean)

  if (lastTodoFunc) {
    tool_calls.push(
      buildCall(tool_calls.length, lastTodoFunc.tool, lastTodoFunc.name, lastTodoFunc.arguments),
    )
  }

  if (!tool_calls.length) return

  const delta = buildToolDelta(tool_calls)
  console.debug('[TOOL] EMIT', delta.tool_calls)
  emit(delta)
}

class ToolStream {
  static setSSEHeaders(res) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
  }

  constructor(res, model, compiler, session) {
    this.res = res
    this.model = model
    this.compiler = compiler
    this.session = session

    this.isNewSession = session.parentMessageId == null
    this.toolCalling = session.toolCalling ?? true
    this.haveInstructionsAPI = false

    this.inTool = false
    this.toolStartFound = false
    this.buffer = ''
    this.toolBuffers = []
    this.toolIndex = compiler.tools
    this.lastChar = ''
    this._maxToolLen = Math.max(...Object.keys(compiler.tools).map((k) => k.length)) + 3

    const completionId = `chatcmpl-${Date.now()}${Math.random().toString(36).slice(2, 8)}`
    const created = Math.floor(Date.now() / 1000)
    const chunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [],
    }

    this.emit = (delta, finishReason = null, usage = null) => {
      chunk.choices = [{ index: 0, delta, finish_reason: finishReason, logprobs: null }]

      if (usage != null) {
        chunk.usage = usage
      }

      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }

    this.tokenUsage = {}
    this._finished = false

    this.emitText = (content, role = 'assistant') => this.emit({ role, content })

    this.uploadFile = async (uploadFn, file, collector) => {
      this.emitText(`\nUploading ${file.filename}...`)
      const result = await uploadFn(file)
      this.emitText(' done.\n')
      collector.push(result)
      return result
    }

    // Curry: bind an API's uploadFile once per request and store it on the
    // parser itself — routes call `parser.bindUploader(api, collector)` once,
    // formatPrompt then calls `parser.upload(file)` with no extra param needed.
    this.bindUploader = (api, collector) => {
      this.upload = (file) => this.uploadFile(api.uploadFile.bind(api), file, collector)
    }

    this.sendFinalChunk = () => {
      if (this._finished) return
      this._finished = true
      this.flush()
      this.emit({}, 'stop', this.tokenUsage)
      this.res.write('data: [DONE]\n\n')
      this.res.end()
      this.session.lastUsed = new Date().toISOString()
    }

    this.onError = (err) => {
      const classified = classifyError(err, this.compiler.provider)
      console.error(
        `[${this.compiler.provider}] Stream error (${classified.category}): ${err.message}`,
      )
      if (this._finished) return
      this._finished = true
      this.emit({}, 'error', {})
      if (!this.res.writableEnded) {
        this.res.write(
          `data: ${JSON.stringify({ error: { message: classified.message, action: classified.action, category: classified.category } })}\n\n`,
        )
        this.res.end()
      }
    }

    this.emitAndEnd = (text) => {
      this.scan(text)
      this.flush()
      this.emit({}, 'stop', {})
      this.res.write('data: [DONE]\n\n')
      this.res.end()
    }
  }

  scan(text) {
    this.buffer += text

    while (true) {
      // STATE: inside tool body, scanning for close bracket
      if (this.inTool) {
        const closeIdx = this.buffer.indexOf(BPI.CLOSE)
        if (closeIdx === -1) return
        const payload = this.buffer.slice(1, closeIdx)
        this.buffer = this.buffer.slice(closeIdx + 1)
        this.inTool = false
        this.toolStartFound = false

        if (this.compiler.ideName === 'vscode') {
          emitToolCalls(this.compiler, this.session, [payload], this.emit)
        } else {
          this.toolBuffers.push(payload)
        }

        continue
      }

      // STATE: saw open bracket, buffering potential tool name
      if (this.toolStartFound) {
        const pipeIdx = this.buffer.indexOf(BPI.SEP)
        if (pipeIdx === -1) {
          if (this.buffer.length <= this._maxToolLen) return
          // Too long — not a valid tool name
          this.emitText(this.buffer)
          this.buffer = ''
          this.toolStartFound = false
          return
        }

        const tool = this.buffer.slice(1, pipeIdx)
        if (this.toolIndex[tool]) {
          console.debug('[TOOL]', tool)
          this.inTool = true
          continue
        }

        // Not a tool — emit open bracket + name + pipe as plain text, keep scanning
        this.emitText(this.buffer.slice(0, pipeIdx + 1))
        this.buffer = this.buffer.slice(pipeIdx + 1)
        this.toolStartFound = false
        continue
      }

      // STATE: normal text, scanning for open bracket
      const startIdx = this.buffer.indexOf(BPI.OPEN)
      if (startIdx === -1) {
        if (this.buffer) this.lastChar = this.buffer[this.buffer.length - 1]
        this.emitText(this.buffer)
        this.buffer = ''
        return
      }

      const charBefore = startIdx > 0 ? this.buffer[startIdx - 1] : this.lastChar
      if (charBefore === '`') {
        // Preceded by a backtick — literal/example syntax, not a real tool call. Skip it.
        this.emitText(this.buffer.slice(0, startIdx + 1))
        this.lastChar = BPI.OPEN
        this.buffer = this.buffer.slice(startIdx + 1)
        continue
      }

      this.emitText(this.buffer.slice(0, startIdx))
      if (startIdx > 0) this.lastChar = this.buffer[startIdx - 1]
      this.buffer = this.buffer.slice(startIdx)
      this.toolStartFound = true
    }
  }

  flush() {
    if (this.inTool) this.scan(BPI.CLOSE)

    emitToolCalls(this.compiler, this.session, this.toolBuffers, this.emit)

    if (!this.toolStartFound || !this.buffer) return

    // Stream ended mid tool-name — emit as plain text
    this.emitText(this.buffer)
    this.buffer = ''
    this.toolStartFound = false
  }
}

module.exports = { ToolStream }
