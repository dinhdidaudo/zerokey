const BPI = require('./bpi')
const ToolCompiler = require('./compiler')
const { toOpenAIError } = require('../utils/errors')
const { restoreMcpInjections, showAvailableMcpTags, handleSkill } = require('./triggers')

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
  const compiled = payloads
    .flatMap((payload) => {
      const func = compiler.compile(payload, session)
      if (!func) return []
      return Array.isArray(func) ? func : [func]
    })
    .filter(Boolean)

  if (!compiled.length) return

  const ordered = []
  let todoGroup = []

  for (const f of compiled) {
    if (TODO_TOOLS.has(f.tool)) {
      todoGroup.push(f)
    } else {
      if (todoGroup.length) {
        ordered.push(todoGroup.pop())
        todoGroup = []
      }
      ordered.push(f)
    }
  }
  // Flush any remaining todo group at the end.
  if (todoGroup.length) ordered.push(todoGroup.pop())

  const tool_calls = ordered.map((f, i) => buildCall(i, f.tool, f.name, f.arguments))

  if (!tool_calls.length) return

  const delta = buildToolDelta(tool_calls)
  console.debug('[TOOL] EMIT', delta.tool_calls)
  emit(delta)
}

class StreamPipeline {
  static setSSEHeaders(res) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
  }

  /**
   * @param {import('express').Response} res
   * @param {object} session
   * @param {string} provider - 'deepseek' | 'claude' | 'chatgpt'
   * @param {string} ideName - 'vscode' | 'terax' | 'opencode'
   */
  constructor(res, session, provider, ideName) {
    this.compiler = new ToolCompiler(ideName, provider)

    this.res = res
    this.provider = provider
    this.session = session

    this.isNewSession = session.parentMessageId == null
    this.toolCalling = session.toolCalling ?? true
    this.haveInstructionsAPI = false

    this.inTool = false
    this.toolStartFound = false
    this.buffer = ''
    this.toolBuffers = []
    this.toolIndex = this.compiler.tools
    this.lastChar = ''
    this._maxToolLen = Math.max(...Object.keys(this.compiler.tools).map((k) => k.length)) + 3

    const chunk = {
      id: `chatcmpl-${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: this.compiler.provider,
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

    // bindUploader curries the API's uploadFile — must be set per-request.
    this.bindUploader = (api, collector) => {
      this.upload = (file) => this._uploadFile(api.uploadFile.bind(api), file, collector)
    }
  }

  upload(_file) {}

  // ── public emit methods ────────────────────────────────────────────────
  emit(delta, _finishReason = null, _usage = null) {}

  emitText(content, role = 'assistant') {
    this.emit({ role, content })
  }

  emitAndEnd(text) {
    this.scan(text)
    this.flush()
    this.emit({}, 'stop', {})
    this.res.write('data: [DONE]\n\n')
    this.res.end()
  }

  sendFinalChunk() {
    if (this._finished) return
    this._finished = true
    this.flush()
    this.emit({}, 'stop', this.tokenUsage)
    this.res.write('data: [DONE]\n\n')
    this.res.end()
    this.session.lastUsed = new Date().toISOString()
  }

  // ── file upload ────────────────────────────────────────────────────────

  async _uploadFile(uploadFn, file, collector) {
    this.emitText(`\nUploading ${file.filename}...`)
    const result = await uploadFn(file)
    this.emitText(' done.\n')
    collector.push(result)
    return result
  }

  // ── pipeline setup ─────────────────────────────────────────────────────

  /**
   * Shared pipeline: restore MCP injections, format prompt, build prompt,
   * show available MCP tags on new sessions, and handle skills.
   * Returns { prompt } — if a skill was triggered the response is already
   * ended by handleSkill and the caller should return early.
   *
   * @param {Array}  messages
   * @param {Array}  tools
   * @param {object} req
   * @returns {Promise<{prompt: string, handled: boolean}>}
   */
  async setup(messages, tools, req) {
    restoreMcpInjections(this.session, this.compiler.tools, tools)

    const { prompt, skill } = await this.compiler.formatPrompt(messages, this)

    if (skill) {
      handleSkill(skill, req, this)
      return { prompt: '', handled: true }
    }

    const built = this.compiler.buildPrompt(prompt, this)

    if (this.isNewSession) {
      showAvailableMcpTags(tools, this)
    }

    return { prompt: built, handled: false }
  }

  // ── error handling ─────────────────────────────────────────────────────

  /**
   * Emit an error through the stream in OpenAI-compatible format.
   * @param {Error} error
   */
  onError(error) {
    console.error(`[${this.provider}] Route error: ${error.message}`)
    const err = toOpenAIError(error, this.provider)
    this.emitAndEnd(`\n\n⚠ ${err.error.message}${err.error.action ? ' ' + err.error.action : ''}\n`)
  }

  // ── BPI scanning ───────────────────────────────────────────────────────

  scan(text) {
    this.buffer += text

    while (true) {
      if (this.inTool) {
        const closeIdx = this.buffer.indexOf(BPI.CLOSE)
        if (closeIdx === -1) return
        const payload = this.buffer.slice(1, closeIdx)
        this.buffer = this.buffer.slice(closeIdx + 1)
        this.inTool = false
        this.toolStartFound = false

        this.toolBuffers.push(payload)
        continue
      }

      if (this.toolStartFound) {
        const pipeIdx = this.buffer.indexOf(BPI.SEP)
        if (pipeIdx === -1) {
          if (this.buffer.length <= this._maxToolLen) return
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

        this.emitText(this.buffer.slice(0, pipeIdx + 1))
        this.buffer = this.buffer.slice(pipeIdx + 1)
        this.toolStartFound = false
        continue
      }

      const startIdx = this.buffer.indexOf(BPI.OPEN)
      if (startIdx === -1) {
        if (this.buffer) this.lastChar = this.buffer[this.buffer.length - 1]
        this.emitText(this.buffer)
        this.buffer = ''
        return
      }

      const charBefore = startIdx > 0 ? this.buffer[startIdx - 1] : this.lastChar
      if (charBefore === '`') {
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

    this.emitText(this.buffer)
    this.buffer = ''
    this.toolStartFound = false
  }
}

module.exports = { StreamPipeline }
