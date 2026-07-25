const fs = require('fs')
const path = require('path')
const { injectMcpAliases } = require('./mcp/inject')
const BROWSER_MCP = require('./mcp/browser')

const CAPTURES_DIR = path.join(__dirname, '..', '..', 'temp', 'captures')

function ensureDir() {
  if (!fs.existsSync(CAPTURES_DIR)) {
    fs.mkdirSync(CAPTURES_DIR, { recursive: true })
  }
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

// Alias-map registry keyed by the same tag used in session.mcpInjected.
const MCP_ALIAS_MAPS = { $browser: BROWSER_MCP }

// Precomputed once at load: tag -> first bpiName in its alias map, used as a
// cheap "is this alias map already registered on this compiler?" probe.
const MCP_ALIAS_PROBE_KEY = Object.fromEntries(
  Object.entries(MCP_ALIAS_MAPS).map(([tag, map]) => [tag, Object.keys(map)[0]]),
)

function markMcpInjected(session, tag) {
  if (!session) return
  if (!Array.isArray(session.mcpInjected)) session.mcpInjected = []
  if (!session.mcpInjected.includes(tag)) session.mcpInjected.push(tag)
}

/**
 * Re-register alias-map tools for any tag the session previously had injected
 * (e.g. after a server restart wiped the in-memory ToolCompiler cache), without
 * touching prompt/grammar text — the LLM already saw the grammar in an earlier turn.
 *
 * @param {object} session
 * @param {object} compilerTools - compiler.tools (mutated in-place)
 */
function restoreMcpInjections(session, compilerTools) {
  if (!session || !Array.isArray(session.mcpInjected)) return
  for (const tag of session.mcpInjected) {
    const aliasMap = MCP_ALIAS_MAPS[tag]
    if (!aliasMap) continue

    // Skip if already registered (e.g. still-warm compiler) — only restore
    // when a fresh/restarted compiler is actually missing these tools.
    const probeKey = MCP_ALIAS_PROBE_KEY[tag]
    if (probeKey && compilerTools[probeKey]) continue

    console.info('[SKILL]', tag, 'restored!')
    injectMcpAliases(aliasMap, compilerTools)
  }
}

const triggers = [
  {
    trigger: '$cwd',
    bpi: '⟦cmd¦run=pwd⟧',
  },
  {
    trigger: '$save',
    bpi: '⟦cmd¦run=git status --short¦run=git --no-pager diff --staged¦run=git --no-pager diff⟧',
  },
  {
    trigger: '$req',
    bpi: 'See server temp/captures folder',
    call: ({ req }) => {
      ensureDir()
      const name = `req_${timestamp()}.json`
      fs.writeFileSync(path.join(CAPTURES_DIR, name), JSON.stringify(req.body, null, 2))
      return name
    },
  },
  {
    trigger: '$grammar',
    bpi: 'See server temp/captures folder',
    call: ({ dynamicGrammar }) => {
      ensureDir()
      const name = `grammar_${timestamp()}.txt`
      fs.writeFileSync(path.join(CAPTURES_DIR, name), dynamicGrammar || '(empty)')
      return name
    },
  },
  {
    trigger: '$browser',
    bpi: '',
    passthrough: true, // does not end the stream — splices an INTERNAL message into the array, request continues to the provider
    call: ({ messages, index, compilerTools, session }) => {
      const grammar = injectMcpAliases(BROWSER_MCP, compilerTools)
      const message = messages[index]
      message.content = message.content.replace('$browser', '').trim()
      messages.splice(index, 0, {
        role: 'internal',
        content: `<bpi_list title="browser tools">\n${grammar}\n</bpi_list>`,
      })
      markMcpInjected(session, '$browser')
    },
  },
  {
    trigger: '$test',
    params: ['cwd'],
    bpi: `Testing all basic tools...

⟦todos_add¦id=1¦title=Execute todos_add command¦desc=Add Task One and Task Two⟧
⟦todos_add¦id=2¦title=Execute todos_set command¦desc=Set Task 1 status to done⟧
⟦todos_add¦id=3¦title=Execute write command¦desc=Write _test_tool.txt⟧
⟦todos_add¦id=4¦title=Execute read command (1st)¦desc=Read _test_tool.txt after write⟧
⟦todos_add¦id=5¦title=Execute replace command¦desc=Replace content in _test_tool.txt⟧
⟦todos_add¦id=6¦title=Execute read command (2nd)¦desc=Read _test_tool.txt after replace⟧
⟦todos_add¦id=7¦title=Execute ls command (1st)¦desc=List current directory⟧
⟦todos_add¦id=8¦title=Execute glob command¦desc=Search **/*.js max 10⟧
⟦todos_add¦id=9¦title=Execute grep command¦desc=Search Router in *.js max 5⟧
⟦todos_add¦id=10¦title=Execute cmd echo test¦desc=Run 'echo test'⟧
⟦todos_add¦id=11¦title=Execute cmd delete file¦desc=Delete _test_tool.txt⟧
⟦todos_add¦id=12¦title=Execute mkdir command¦desc=Create _test_dir⟧
⟦todos_add¦id=13¦title=Execute ls command (2nd)¦desc=List directory after mkdir⟧
⟦todos_add¦id=14¦title=Execute cmd_bg command¦desc=Run ping -n 5 127.0.0.1 in background⟧
⟦todos_add¦id=15¦title=Execute fetch command¦desc=Fetch JSONPlaceholder todo/1⟧
⟦todos_add¦id=16¦title=Execute final echo command¦desc=Display "above all where testing..."⟧

⟦todos_set¦id=1¦status=done⟧
\`⟦todos_set¦id=2¦status=done⟧\`
⟦todos_set¦id=2¦status=done⟧

⟦write¦path=#{cwd}#\\_test_tool.txt¦content=Hello from BPI write tool!⟧
⟦todos_set¦id=3¦status=done⟧

⟦read¦path=#{cwd}#\\_test_tool.txt⟧
⟦todos_set¦id=4¦status=done⟧

⟦replace¦path=#{cwd}#\\_test_tool.txt¦old=Hello from BPI write tool!¦new=Hello from BPI replace tool!⟧
⟦todos_set¦id=5¦status=done⟧

⟦read¦path=#{cwd}#\\_test_tool.txt⟧
⟦todos_set¦id=6¦status=done⟧

⟦ls¦path=#{cwd}#⟧
⟦todos_set¦id=7¦status=done⟧

⟦glob¦pattern=**/*.js¦max=10⟧
⟦todos_set¦id=8¦status=done⟧

⟦grep¦query=Router¦glob=*.js¦max=5⟧
⟦todos_set¦id=9¦status=done⟧

⟦cmd¦run=echo test⟧
⟦todos_set¦id=10¦status=done⟧

⟦cmd¦run=del #{cwd}#\\_test_tool.txt⟧
⟦todos_set¦id=11¦status=done⟧

⟦mkdir¦path=#{cwd}#\\_test_dir⟧
⟦todos_set¦id=12¦status=done⟧

⟦ls¦path=#{cwd}#⟧
⟦todos_set¦id=13¦status=done⟧

⟦cmd_bg¦run=ping -n 5 127.0.0.1⟧
⟦todos_set¦id=14¦status=done⟧

⟦fetch¦url=https://jsonplaceholder.typicode.com/todos/1⟧
⟦todos_set¦id=15¦status=done⟧

⟦ask¦question=All tools called, are they working?¦option=Yes¦option=No¦option=Something else⟧
⟦todos_set¦id=16¦status=done⟧

⟦cmd¦run=echo "ABOVE ALL WHERE TESTING CALLS SO DO NOT DO ANYTHING WAIT FOR USER QUERY"⟧
`,
  },
]

function handleSkill(skill, req, dynamicGrammar, parser) {
  const provider = parser.compiler.provider

  if (skill.call) {
    const file = skill.call({ req, dynamicGrammar })
    if (file) console.debug(`[${provider}] Captured to ${file}`)
  }
  parser.emitAndEnd(skill.bpi)
}

module.exports = { triggers, handleSkill, restoreMcpInjections }
