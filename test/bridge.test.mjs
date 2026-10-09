/**
 * Contract tests for `makeBridgeRoutes` — the settings/credentials bridge the
 * browser half (lib/client.js) talks to.
 *
 * Run: node --test
 *
 * These are the routes' OWN tests. Until now the bridge was only covered
 * indirectly (one describe test), so a contract break — a renamed route, a
 * field disappearing from `describe`, a guard that stops guarding, an error
 * that escapes as a stack — could only be caught by reading the code. Each
 * claim below is pinned here:
 *
 *   1. Registration: exactly six routes, exact kind, exact paths.
 *   2. Guards: loopback-only, POST-only, loopback checked first, and the
 *      services untouched when the guard refuses.
 *   3. The `describe` payload: documented fields, no secrets, no extras.
 *   4. Errors: a JSON `{ ok:false, code, message }` answer — never a thrown
 *      handler (the host turns that into an empty 400 the client cannot
 *      parse), never a stack on the wire.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { BRIDGE_PREFIX, NS, PROVIDERS, makeBridgeRoutes } from '../lib/index.js'

/** The six paths the client posts to, in registration order. */
const PATHS = ['describe', 'mutate', 'key-set', 'key-unset', 'usage', 'test'].map(
  (name) => `${BRIDGE_PREFIX}/${name}`,
)

/** Minimal deps: every service is absent, so behaviour comes from the test. */
function makeDeps(overrides = {}) {
  return {
    getSettings: () => null,
    getConfig: () => ({ enabled: true, provider: 'typesafe', model: '', baseUrl: '' }),
    getCredentials: () => null,
    getLedger: () => null,
    probe: async () => ({ provider: 'typesafe' }),
    ...overrides,
  }
}

/** Deps that record (and refuse) any touch — used to prove the guards bite. */
function forbiddenDeps(touched) {
  const touch = (name) => () => {
    touched.push(name)
    throw new Error(`${name} must not be reached behind a refused guard`)
  }
  return makeDeps({
    getSettings: touch('getSettings'),
    getConfig: touch('getConfig'),
    getCredentials: touch('getCredentials'),
    getLedger: touch('getLedger'),
    probe: touch('probe'),
  })
}

function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
      this.writableEnded = true
    },
  }
}

/**
 * A request double. `body` is what `readJsonBody` will consume: an object is
 * serialised, a string is sent verbatim (so malformed and oversized payloads
 * can be exercised), and leaving it out sends nothing at all.
 */
function makeReq({ method = 'POST', remoteAddress = '127.0.0.1', body } = {}) {
  const chunks = body === undefined
    ? []
    : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return {
    method,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
}

/**
 * Invoke one route and return the parsed answer. Rejects (failing the test)
 * if the handler throws instead of answering, or answers nothing.
 */
async function call(routes, name, req, depsForMessage = name) {
  const route = routes.find((candidate) => candidate.path === `${BRIDGE_PREFIX}/${name}`)
  assert.ok(route, `the ${name} route is registered at ${BRIDGE_PREFIX}/${name}`)
  const res = makeRes()
  await route.handler(req, res)
  assert.equal(res.writableEnded, true, `${depsForMessage} must end the response`)
  assert.match(
    String(res.headers?.['content-type'] ?? ''),
    /^application\/json/,
    `${depsForMessage} must answer JSON`,
  )
  return { status: res.statusCode, headers: res.headers, raw: res.body, body: JSON.parse(res.body) }
}

// --------------------------------------------------------------- registration

test('the bridge registers exactly six exact routes under the bridge prefix', () => {
  const routes = makeBridgeRoutes(makeDeps())
  assert.equal(routes.length, PATHS.length, 'the route count is part of the contract')
  assert.deepEqual(
    routes.map((route) => route.path),
    PATHS,
  )
  for (const route of routes) {
    assert.equal(route.kind, 'exact', `${route.path} must be an exact route, not a prefix`)
    assert.equal(typeof route.handler, 'function', `${route.path} needs a handler`)
    assert.ok(route.path.startsWith('/api/'), `${route.path} must stay under /api (same-origin)`)
    assert.ok(!route.path.endsWith('/'), `${route.path} must not carry a trailing slash`)
  }
})

// --------------------------------------------------------------------- guards

test('every bridge route refuses a non-loopback peer before touching a service', async () => {
  const touched = []
  const routes = makeBridgeRoutes(forbiddenDeps(touched))
  for (const route of routes) {
    const res = makeRes()
    await route.handler(makeReq({ remoteAddress: '198.51.100.7' }), res)
    assert.equal(res.statusCode, 403, `${route.path} must refuse a remote peer`)
    const body = JSON.parse(res.body)
    assert.deepEqual(body, { ok: false, code: 'forbidden', message: 'loopback requests only' })
  }
  assert.deepEqual(touched, [], 'no service may be reached behind a refused guard')
})

test('every bridge route answers 405 to a non-POST method', async () => {
  const touched = []
  const routes = makeBridgeRoutes(forbiddenDeps(touched))
  for (const route of routes) {
    const res = makeRes()
    await route.handler(makeReq({ method: 'GET' }), res)
    assert.equal(res.statusCode, 405, `${route.path} must refuse GET`)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, false)
    assert.equal(body.code, 'method-not-allowed')
    assert.match(body.message, /POST only \(got GET\)/)
  }
  assert.deepEqual(touched, [], 'no service may be reached behind a refused guard')
})

test('the loopback check runs before the method check', async () => {
  // A remote GET must read as "forbidden", not as "use POST": the peer is not
  // entitled to learn anything about the bridge, not even its method policy.
  const routes = makeBridgeRoutes(forbiddenDeps([]))
  const res = makeRes()
  await routes[0].handler(makeReq({ method: 'GET', remoteAddress: '198.51.100.7' }), res)
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).code, 'forbidden')
})

// ------------------------------------------------------------------- describe

/** A fully wired settings service, credentials store and ledger for `describe`. */
function describeDeps(overrides = {}) {
  return makeDeps({
    getSettings: () => ({
      writable: true,
      describe: (options) => {
        assert.deepEqual(options, { redactSecrets: true }, 'describe must ask for redacted secrets')
        return [
          { ns: 'someone-else', revision: 99 },
          { ns: NS, revision: 7 },
        ]
      },
    }),
    getConfig: () => ({
      enabled: true,
      provider: 'typesafe',
      model: 'jev-1.13.0',
      baseUrl: '',
      timeoutMs: 30000,
      // A legacy key may still live in settings.yaml; it must never travel.
      apiKey: 'sk-legacy-in-settings-123456',
    }),
    getCredentials: () => ({
      describe: async (ref) => {
        assert.equal(ref, 'TYPESAFE_API_KEY', 'the view must describe the selected credential')
        return { configured: true }
      },
      resolve: async () => ({ value: 'sk-stored-credential-654321' }),
    }),
    getLedger: () => ({
      summary: () => ({ calls: 3, inputTokens: 1200, costUsd: 0.0504 }),
    }),
    ...overrides,
  })
}

test('the describe payload carries exactly the documented fields', async () => {
  const previous = process.env.TYPESAFE_API_KEY
  delete process.env.TYPESAFE_API_KEY // envFallback must be observable, not ambient
  try {
    const { status, body } = await call(makeBridgeRoutes(describeDeps()), 'describe', makeReq())
    assert.equal(status, 200)
    assert.equal(body.ok, true)

    const value = body.value
    assert.deepEqual(
      Object.keys(value).sort(),
      [
        'credential',
        'endpointError',
        'envFallback',
        'keyConfigured',
        'ns',
        'providers',
        'revision',
        'usage',
        'value',
        'writable',
      ],
      'an added or dropped field is a client contract change',
    )
    assert.equal(value.ns, NS)
    assert.equal(value.revision, 7, 'the descriptor for THIS namespace wins')
    assert.deepEqual(
      value.value,
      { enabled: true, provider: 'typesafe', model: 'jev-1.13.0', baseUrl: '', timeoutMs: 30000 },
      'ordinary config values travel to the card',
    )
    assert.equal(value.credential, 'TYPESAFE_API_KEY')
    assert.equal(value.keyConfigured, true)
    assert.equal(value.envFallback, false, 'no env key means no env fallback')
    assert.equal(value.endpointError, null)
    assert.equal(value.writable, true)
    assert.deepEqual(value.usage, { calls: 3, inputTokens: 1200, costUsd: 0.0504 })
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previous
  }
})

test('the describe payload carries no secret material', async () => {
  const previous = process.env.TYPESAFE_API_KEY
  process.env.TYPESAFE_API_KEY = 'sk-env-fallback-789012'
  try {
    const { raw, body } = await call(makeBridgeRoutes(describeDeps()), 'describe', makeReq())
    assert.equal(body.ok, true)
    assert.equal(body.value.keyConfigured, true, 'configured is a flag, never the key')
    assert.equal(body.value.envFallback, true, 'the env fallback is a flag too')
    for (const secret of [
      'sk-legacy-in-settings-123456',
      'sk-stored-credential-654321',
      'sk-env-fallback-789012',
    ]) {
      assert.ok(!raw.includes(secret), `the describe payload leaked "${secret}"`)
    }
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previous
  }
})

test('the describe payload maps every provider the card can render', async () => {
  const { body } = await call(makeBridgeRoutes(describeDeps()), 'describe', makeReq())
  const providers = body.value.providers
  assert.deepEqual(
    providers.map((provider) => provider.id),
    Object.keys(PROVIDERS),
    'every provider must reach the card',
  )
  for (const provider of providers) {
    for (const field of ['id', 'label', 'keyHint', 'credential', 'url', 'model']) {
      assert.equal(typeof provider[field], 'string', `${provider.id}.${field} must be a string`)
    }
    assert.ok(provider.label.length > 0, `${provider.id} needs a label`)
    assert.ok(provider.credential.length > 0, `${provider.id} needs a credential name`)
    assert.ok('limits' in provider && 'modelHint' in provider && 'note' in provider,
      `${provider.id} must expose the optional fields as null when absent`)
  }
  const laya = providers.find((provider) => provider.id === 'laya-studio')
  assert.deepEqual(laya.limits, { maxQuestions: 32, maxOptions: 64 })
})

test('describe reports an unusable endpoint instead of failing the request', async () => {
  const { status, body } = await call(
    makeBridgeRoutes(describeDeps({ getConfig: () => ({ provider: 'nope', model: '' }) })),
    'describe',
    makeReq(),
  )
  assert.equal(status, 200, 'a bad provider is a message, not a broken card')
  assert.equal(body.ok, true)
  assert.match(body.value.endpointError, /unknown provider "nope"/)
  assert.equal(
    body.value.credential,
    'TYPESAFE_API_KEY',
    'without a resolvable endpoint the default credential is shown',
  )
})

test('describe marks the card read-only when settings are not writable', async () => {
  const { body } = await call(
    makeBridgeRoutes(describeDeps({ getSettings: () => ({ writable: false, describe: () => [] }) })),
    'describe',
    makeReq(),
  )
  assert.equal(body.value.writable, false)
  assert.equal(body.value.revision, 0, 'no descriptor for the namespace means revision 0')

  const absent = await call(makeBridgeRoutes(makeDeps()), 'describe', makeReq())
  assert.equal(absent.body.value.writable, true, 'no settings service at all still renders')
})

test('describe reports usage from the ledger, and null when accounting is broken', async () => {
  const summary = { calls: 12, inputTokens: 9999, costUsd: 0.42 }
  const good = await call(
    makeBridgeRoutes(describeDeps({ getLedger: () => ({ summary: () => summary }) })),
    'describe',
    makeReq(),
  )
  assert.deepEqual(good.body.value.usage, summary)

  for (const getLedger of [
    () => null,
    () => ({ summary: () => { throw new Error('the ledger file is gone') } }),
    () => { throw new Error('the data directory is unreadable') },
  ]) {
    const broken = await call(makeBridgeRoutes(describeDeps({ getLedger })), 'describe', makeReq())
    assert.equal(broken.body.ok, true, 'a broken ledger must not break the card')
    assert.equal(broken.body.value.usage, null)
  }
})

test('describe answers a JSON error when a service blows up, without a stack', async () => {
  const { status, raw, body } = await call(
    makeBridgeRoutes(describeDeps({ getSettings: () => { throw new Error('settings service is restarting') } })),
    'describe',
    makeReq(),
  )
  assert.equal(status, 500)
  assert.deepEqual(
    Object.keys(body).sort(),
    ['code', 'message', 'ok'],
    'the error shape must not grow a stack field',
  )
  assert.equal(body.ok, false)
  assert.equal(body.code, 'internal-error')
  assert.equal(body.message, 'settings service is restarting')
  assert.ok(!raw.includes('\n    at '), 'no stack frame may reach the wire')
  assert.ok(!raw.includes('settings service is restarting\n    at'))
})

test('describe survives a credentials service that cannot describe itself', async () => {
  const { status, body } = await call(
    makeBridgeRoutes(describeDeps({
      getCredentials: () => ({ describe: async () => { throw new Error('store locked') } }),
    })),
    'describe',
    makeReq(),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.value.keyConfigured, false, 'an unreadable store reads as "not configured"')
})

// -------------------------------------------------------------------- mutate

test('mutate refuses when the settings service is unavailable', async () => {
  const { status, body } = await call(
    makeBridgeRoutes(makeDeps({ getSettings: () => null })),
    'mutate',
    makeReq({ body: { ops: [{ op: 'set', path: ['enabled'], value: false }] } }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body, {
    ok: false,
    code: 'settings-unavailable',
    message: 'the settings service is not available',
  })
})

test('mutate rejects a malformed body with 400 and a usable message', async () => {
  const routes = makeBridgeRoutes(describeDeps())
  const cases = [
    { label: 'no ops', req: makeReq({ body: {} }) },
    { label: 'ops is not an array', req: makeReq({ body: { ops: 'set' } }) },
    { label: 'not JSON at all', req: makeReq({ body: '{{{ not json' }) },
    { label: `over the body cap`, req: makeReq({ body: `{"ops":["${'x'.repeat(1 << 21)}"]}` }) },
  ]
  for (const { label, req } of cases) {
    const { status, body } = await call(routes, 'mutate', req, `mutate (${label})`)
    assert.equal(status, 400, `mutate must 400 on: ${label}`)
    assert.equal(body.ok, false)
    assert.equal(body.code, 'malformed')
    assert.match(body.message, /ops/)
  }
})

test('mutate forwards ops with the expected revision and returns the fresh view', async () => {
  const seen = []
  // A faithful fake: mutate applies the ops, so the view afterwards differs.
  const config = { enabled: true, provider: 'typesafe', model: '', baseUrl: '' }
  const settings = {
    writable: true,
    describe: () => [{ ns: NS, revision: 8 }],
    mutate: async (...args) => {
      seen.push(args)
      for (const op of args[1]) if (op.op === 'set') config[String(op.path[0])] = op.value
    },
  }
  const ops = [
    { op: 'set', path: ['provider'], value: 'laya-studio' },
    { op: 'set', path: ['model'], value: '' },
  ]
  const { status, body } = await call(
    makeBridgeRoutes(describeDeps({ getConfig: () => config, getSettings: () => settings })),
    'mutate',
    makeReq({ body: { expectedRevision: 7, ops } }),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(seen, [[NS, ops, 7]], 'the namespace, ops and revision must reach settings.mutate')
  assert.equal(body.value.revision, 8, 'the caller gets the post-mutation view')
  assert.equal(body.value.value.provider, 'laya-studio')
})

test('mutate maps a revision conflict and a rejection to distinct codes', async () => {
  const routes = () =>
    makeBridgeRoutes(describeDeps({
      getSettings: () => ({
        mutate: async () => {
          const error = new Error('revision 7 is stale; reload the card')
          error.code = 'SETTINGS_CONFLICT'
          throw error
        },
      }),
    }))
  const conflict = await call(routes(), 'mutate', makeReq({ body: { ops: [] } }))
  assert.equal(conflict.status, 200)
  assert.equal(conflict.body.code, 'settings-conflict')
  assert.match(conflict.body.message, /stale/)

  const rejected = await call(
    makeBridgeRoutes(describeDeps({
      getSettings: () => ({ mutate: async () => { throw new Error('provider is not a known id') } }),
    })),
    'mutate',
    makeReq({ body: { ops: [] } }),
  )
  assert.equal(rejected.status, 200)
  assert.equal(rejected.body.code, 'settings-rejected')
  assert.equal(rejected.body.ok, false)
})

test('mutate answers a JSON error when the settings service itself throws', async () => {
  const { status, body } = await call(
    makeBridgeRoutes(makeDeps({ getSettings: () => { throw new Error('settings is mid-restart') } })),
    'mutate',
    makeReq({ body: { ops: [] } }),
  )
  assert.equal(status, 500)
  assert.equal(body.code, 'internal-error')
  assert.equal(body.message, 'settings is mid-restart')
})

// ------------------------------------------------------------------- key-set

test('key-set refuses when the credentials service is unavailable', async () => {
  const { status, body } = await call(
    makeBridgeRoutes(makeDeps({ getCredentials: () => null })),
    'key-set',
    makeReq({ body: { value: 'sk-anything' } }),
  )
  assert.equal(status, 200)
  assert.deepEqual(body, {
    ok: false,
    code: 'credentials-unavailable',
    message: 'the credentials service is not available',
  })
})

test('key-set demands a non-blank value', async () => {
  const routes = makeBridgeRoutes(describeDeps())
  for (const value of [undefined, '', '   ', 42, null]) {
    const { status, body } = await call(
      routes,
      'key-set',
      makeReq({ body: value === undefined ? {} : { value } }),
      `key-set(${JSON.stringify(value)})`,
    )
    assert.equal(status, 400, `key-set must 400 on ${JSON.stringify(value)}`)
    assert.equal(body.code, 'malformed')
    assert.match(body.message, /value is required/)
  }
})

test('key-set trims the value and stores it under the selected provider credential', async () => {
  const writes = []
  let configured = false
  const deps = (config) =>
    describeDeps({
      getConfig: () => config,
      getCredentials: () => ({
        // The store answers truthfully afterwards: a stored key flips the flag.
        describe: async () => ({ configured }),
        set: async (...args) => {
          writes.push(args)
          configured = true
        },
      }),
    })

  const typesafe = await call(
    makeBridgeRoutes(deps({ provider: 'typesafe', model: '' })),
    'key-set',
    makeReq({ body: { value: '  sk-padded-key-123456  ' } }),
  )
  assert.equal(typesafe.status, 200)
  assert.equal(typesafe.body.ok, true)
  assert.deepEqual(writes, [['TYPESAFE_API_KEY', 'sk-padded-key-123456']], 'the key is stored trimmed')
  assert.ok(!typesafe.raw.includes('sk-padded-key-123456'), 'the response must not echo the key')
  assert.equal(typesafe.body.value.keyConfigured, true, 'the view re-describes the store after the write')

  const custom = await call(
    makeBridgeRoutes(deps({ provider: 'custom', baseUrl: 'https://jev.internal/v1/systemone' })),
    'key-set',
    makeReq({ body: { value: 'sk-custom-key-abcdef' } }),
  )
  assert.equal(custom.body.ok, true)
  assert.deepEqual(writes[1], ['JEV_API_KEY', 'sk-custom-key-abcdef'], 'the credential follows the provider')
})

test('key-set reports a failed write as JSON, with no stack', async () => {
  const { status, raw, body } = await call(
    makeBridgeRoutes(describeDeps({
      getCredentials: () => ({
        set: async () => { throw new Error('the credentials vault is locked') },
      }),
    })),
    'key-set',
    makeReq({ body: { value: 'sk-should-not-matter' } }),
  )
  assert.equal(status, 200)
  assert.equal(body.code, 'credentials-write-failed')
  assert.equal(body.message, 'the credentials vault is locked')
  assert.ok(!raw.includes('    at '), 'no stack frame may reach the wire')
})

// ----------------------------------------------------------------- key-unset

test('key-unset refuses without a credentials service and unsets the selected credential', async () => {
  const unavailable = await call(
    makeBridgeRoutes(makeDeps({ getCredentials: () => null })),
    'key-unset',
    makeReq(),
  )
  assert.equal(unavailable.status, 200)
  assert.equal(unavailable.body.code, 'credentials-unavailable')

  const removed = []
  const ok = await call(
    makeBridgeRoutes(describeDeps({
      getCredentials: () => ({ unset: async (ref) => { removed.push(ref) } }),
    })),
    'key-unset',
    makeReq(),
  )
  assert.equal(ok.body.ok, true)
  assert.deepEqual(removed, ['TYPESAFE_API_KEY'])
})

test('key-unset reports a failed removal as JSON, with no stack', async () => {
  const { status, body, raw } = await call(
    makeBridgeRoutes(describeDeps({
      getCredentials: () => ({ unset: async () => { throw new Error('the vault is read-only') } }),
    })),
    'key-unset',
    makeReq(),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'credentials-write-failed')
  assert.equal(body.message, 'the vault is read-only')
  assert.ok(!raw.includes('\n    at '))
})

// --------------------------------------------------------------------- usage

test('usage reports no-ledger when accounting is off', async () => {
  const { status, body } = await call(
    makeBridgeRoutes(makeDeps({ getLedger: () => null })),
    'usage',
    makeReq(),
  )
  assert.equal(status, 200)
  assert.deepEqual(body, { ok: false, code: 'no-ledger', message: 'the ledger is unavailable' })
})

test('usage returns the summary and resets only when asked', async () => {
  let resets = 0
  const summary = { calls: 5, inputTokens: 4000, costUsd: 0.168 }
  const routes = makeBridgeRoutes(describeDeps({
    getLedger: () => ({ summary: () => summary, reset: () => { resets += 1 } }),
  }))

  const read = await call(routes, 'usage', makeReq({ body: {} }))
  assert.equal(read.body.ok, true)
  assert.deepEqual(read.body.value, summary)
  assert.equal(resets, 0, 'a plain read must not reset the day')

  const reset = await call(routes, 'usage', makeReq({ body: { reset: true } }))
  assert.equal(reset.body.ok, true)
  assert.equal(resets, 1, 'reset:true resets exactly once')
})

test('usage answers a JSON error when the ledger accessor throws', async () => {
  const { status, body, raw } = await call(
    makeBridgeRoutes(makeDeps({ getLedger: () => { throw new Error('the data dir is unreadable') } })),
    'usage',
    makeReq(),
  )
  assert.equal(status, 500)
  assert.equal(body.code, 'internal-error')
  assert.equal(body.message, 'the data dir is unreadable')
  assert.ok(!raw.includes('\n    at '))
})

// ----------------------------------------------------------------------- test

test('the test route returns the probe result verbatim', async () => {
  const probeResult = { provider: 'typesafe', model: 'jev-latest', latencyMs: 41, answers: { q: 1 } }
  const { status, body } = await call(
    makeBridgeRoutes(describeDeps({ probe: async () => probeResult })),
    'test',
    makeReq(),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.value, probeResult)
})

test('a failing probe answers probe-failed with the message and no stack', async () => {
  const { status, raw, body } = await call(
    makeBridgeRoutes(describeDeps({
      probe: async () => { throw new Error('no API key configured for "typesafe"') },
    })),
    'test',
    makeReq(),
  )
  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.code, 'probe-failed')
  assert.equal(body.message, 'no API key configured for "typesafe"')
  assert.ok(!raw.includes('\n    at '), 'a failed probe must not ship a stack trace')
})

// -------------------------------------------------------------------- headers

test('every answer carries the JSON content type and a no-referrer policy', async () => {
  const routes = makeBridgeRoutes(describeDeps())
  const answers = [
    await call(routes, 'describe', makeReq()),
    await call(routes, 'describe', makeReq({ remoteAddress: '198.51.100.7' })),
    await call(routes, 'key-set', makeReq({ body: {} })),
  ]
  for (const { headers } of answers) {
    assert.equal(headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(headers['referrer-policy'], 'no-referrer')
  }
})
