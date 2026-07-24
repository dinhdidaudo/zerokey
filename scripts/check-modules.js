const modules = [
  './utils/errors',
  './utils/stream-helpers',
  './utils/route-helpers',
  './utils/rate-limiter',
  './utils/cookie-jar',
  './utils/sse-reader',
  './lib/engine',
]

const path = require('path')
const root = path.join(__dirname, '..')

let failed = 0
for (const mod of modules) {
  try {
    require(path.join(root, mod))
  } catch (err) {
    console.error(`FAIL: ${mod} — ${err.message}`)
    failed++
  }
}

if (failed) {
  console.error(`\n${failed} module(s) failed to load`)
  process.exit(1)
}

console.log(`OK: ${modules.length} modules loaded`)
