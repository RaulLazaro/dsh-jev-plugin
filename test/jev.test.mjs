/**
 * Unit tests for the pure parts of dsh-jev-plugin.
 *
 * Run: node --test
 *
 * These cover the request shape, the provider resolution, the validation
 * messages a model will actually see, and the retry policy — the places where a
 * mistake turns into a silent wrong answer or a hung turn.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PROVIDERS,
  formatAnswers,
  isLoopbackRequest,
  makeBridgeRoutes,
  makeTool,
  redactSecret,
  resolveEndpoint,
  resolveApiKey,
  validateQuestions,
  callJev,
  RETRY_DELAYS_MS,
} from '../lib/index.js'

test('resolveEndpoint picks the documented endpoint per provider', () => {
  assert.equal(resolveEndpoint({ provider: 'typesafe' }).url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(resolveEndpoint({ provider: 'typesafe' }).model, 'jev-latest')
  assert.equal(
    resolveEndpoint({ provider: 'vercel-gateway' }).url,
    'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
  )
  assert.equal(resolveEndpoint({ provider: 'vercel-gateway' }).model, 'typesafe-ai/jev')
})

test('resolveEndpoint defaults to typesafe when unset', () => {
  assert.equal(resolveEndpoint({}).id, 'typesafe')
  assert.equal(resolveEndpoint(undefined).id, 'typesafe')
})

test('resolveEndpoint honours a model override but keeps the provider model otherwise', () => {
  assert.equal(resolveEndpoint({ provider: 'typesafe', model: 'jev-1.13.0' }).model, 'jev-1.13.0')
  assert.equal(resolveEndpoint({ provider: 'typesafe', model: '   ' }).model, 'jev-latest')
})

test('resolveEndpoint rejects an unknown provider with a usable message', () => {
  const result = resolveEndpoint({ provider: 'nope' })
  assert.match(result.error, /unknown provider "nope"/)
  assert.match(result.error, /typesafe/)
})

test('resolveEndpoint requires a usable URL for the custom provider', () => {
  assert.match(resolveEndpoint({ provider: 'custom' }).error, /needs a base URL/)
  assert.match(resolveEndpoint({ provider: 'custom', baseUrl: 'ftp://x' }).error, /http/)
  assert.equal(
    resolveEndpoint({ provider: 'custom', baseUrl: 'https://jev.internal/v1/systemone' }).url,
    'https://jev.internal/v1/systemone',
  )
})

test('validateQuestions normalises each question type', () => {
  const out = validateQuestions({
    a: { type: 'noul', instructions: 'Did it fail?' },
    b: { type: 'choice', instructions: 'Which?', criteria: { x: 'one', y: 'two' } },
    c: { type: 'score', instructions: 'How bad?', criteria: ['low', 'mid', 'high'] },
  })
  assert.deepEqual(Object.keys(out), ['a', 'b', 'c'])
  assert.equal(out.a.type, 'noul')
  assert.deepEqual(out.b.criteria, { x: 'one', y: 'two' })
  assert.deepEqual(out.c.criteria, ['low', 'mid', 'high'])
})

test('validateQuestions names the offending path', () => {
  assert.throws(() => validateQuestions({ q: { type: 'boolean', instructions: 'x' } }), /questions\.q\.type/)
  assert.throws(() => validateQuestions({ q: { type: 'noul' } }), /questions\.q\.instructions/)
  assert.throws(() => validateQuestions({ q: { type: 'choice', instructions: 'x' } }), /criteria must be an object/)
  assert.throws(
    () => validateQuestions({ q: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } }),
    /at least two options/,
  )
  assert.throws(
    () => validateQuestions({ q: { type: 'score', instructions: 'x', criteria: ['only'] } }),
    /at least two ordered labels/,
  )
})

test('validateQuestions rejects an empty, non-object or oversized map', () => {
  assert.throws(() => validateQuestions({}), /at least one question/)
  assert.throws(() => validateQuestions(null), /must be an object/)
  assert.throws(() => validateQuestions([]), /must be an object/)
  assert.throws(() => validateQuestions({ a: {}, b: {} }, 1), /too many questions \(2\)/)
})

test('validateQuestions demands a non-empty string instructions', () => {
  // A blank, padded or non-string `instructions` used to pass validation and
  // surface as a raw provider 400 (or as a paid call that judges nothing).
  assert.throws(
    () => validateQuestions({ q: { type: 'noul', instructions: '' } }),
    /questions\.q\.instructions must be a non-empty string/,
  )
  assert.throws(() => validateQuestions({ q: { type: 'noul', instructions: '   ' } }), /non-empty string/)
  assert.throws(() => validateQuestions({ q: { type: 'noul', instructions: { hint: 'x' } } }), /non-empty string/)
  // A padded-but-real instruction is the caller's data: pass it through.
  assert.equal(validateQuestions({ q: { type: 'noul', instructions: ' ok ' } }).q.instructions, ' ok ')
})

test('validateQuestions keeps a question named __proto__ instead of dropping it', () => {
  // A JSON blob under judgement can plausibly carry that key. `out[key] = entry`
  // hit Object.prototype's setter: the question vanished and the model was told
  // "(no answer)" — or the provider answered 400 for an empty question map.
  const raw = JSON.parse(
    '{"__proto__":{"type":"noul","instructions":"x"},"plain":{"type":"noul","instructions":"y"}}',
  )
  const out = validateQuestions(raw)
  assert.deepEqual(Object.keys(out), ['__proto__', 'plain'], 'every question must survive validation')
  assert.equal(Object.getPrototypeOf(out), Object.prototype, 'the question must not hijack the prototype')
  assert.equal(JSON.parse(JSON.stringify(out)).__proto__.type, 'noul', 'it must reach the provider')
})

test('formatAnswers renders every answer type and a usage footer', () => {
  const text = formatAnswers(
    {
      model: 'typesafe-ai/jev',
      answers: {
        n: { type: 'noul', noul: 0.9 },
        c: { type: 'choice', choice: 'billing', confidence: 0.31, probabilities: { billing: 0.54, tech: 0.46 } },
        s: { type: 'score', score: 2.5, confidence: 0.8, probabilities: { '0': 0, '1': 0.5, '2': 0.5 } },
      },
      usage: { input_tokens: 434, output_tokens: 97 },
    },
    ['n', 'c', 's'],
  )
  assert.match(text, /^n: 0\.9 \(yes\)/m)
  assert.match(text, /^c: billing \| confidence 0\.31/m)
  assert.match(text, /^s: 2\.5 \| confidence 0\.8/m)
  assert.match(text, /3 questions \| 434 input tokens \| model typesafe-ai\/jev/)
})

test('formatAnswers reports a missing answer instead of dropping it', () => {
  const text = formatAnswers({ answers: {} }, ['gone'])
  assert.match(text, /^gone: \(no answer\)/m)
})

test('formatAnswers accepts the gateway camelCase usage field', () => {
  const text = formatAnswers({ answers: {}, usage: { inputTokens: 12 } }, [])
  assert.match(text, /12 input tokens/)
})

test('resolveApiKey prefers the credentials store, then settings, then the environment', async () => {
  const credentials = { resolve: async (ref) => (ref === 'TYPESAFE_API_KEY' ? { value: 'from-store' } : undefined) }
  assert.equal(await resolveApiKey(credentials, 'TYPESAFE_API_KEY', 'from-settings'), 'from-store')
  assert.equal(await resolveApiKey({ resolve: async () => undefined }, 'TYPESAFE_API_KEY', 'from-settings'), 'from-settings')

  process.env.JEV_TEST_KEY = 'from-env'
  assert.equal(await resolveApiKey(undefined, 'JEV_TEST_KEY', undefined), 'from-env')
  assert.equal(await resolveApiKey(undefined, 'JEV_TEST_KEY', ''), 'from-env')
  delete process.env.JEV_TEST_KEY
})

test('resolveApiKey survives a credentials store that throws', async () => {
  const broken = {
    resolve: async () => {
      throw new Error('store unavailable')
    },
  }
  assert.equal(await resolveApiKey(broken, 'TYPESAFE_API_KEY', 'from-settings'), 'from-settings')
})

test('resolveApiKey trims the key and treats whitespace as missing', async () => {
  // A key pasted with a stray newline (a common .env accident) would become an
  // invalid header; a whitespace-only value must read as "not configured".
  process.env.JEV_TRIM_TEST_KEY = '  sk-padded-value\n'
  assert.equal(await resolveApiKey(undefined, 'JEV_TRIM_TEST_KEY', undefined), 'sk-padded-value')
  delete process.env.JEV_TRIM_TEST_KEY

  assert.equal(
    await resolveApiKey({ resolve: async () => ({ value: '   ' }) }, 'JEV_TRIM_TEST_KEY', '  '),
    '',
    'a blank key must fall through, not travel as `Bearer    `',
  )
})

/** Run `body` with globalThis.fetch replaced, restoring it even on failure. */
async function withFetchStub(impl, body) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await body()
  } finally {
    globalThis.fetch = original
  }
}

/**
 * The tool takes the credentials *accessor*, and every call must read the
 * service through it. Wiring the service in eagerly — or passing the accessor
 * where the service is expected — made every real call fail with "no API key"
 * while the Settings card's own probe still passed, because the probe invokes
 * the accessor and the tool did not.
 */
test('the jev tool resolves its key through the credentials accessor', async () => {
  const credentials = { resolve: async () => ({ value: 'from-store' }) }
  const tool = makeTool(
    () => credentials,
    () => ({ provider: 'vercel-gateway' }),
  )
  const seen = []
  await withFetchStub(
    async (url, init) => {
      seen.push({ url, authorization: init.headers.authorization })
      return new Response(JSON.stringify({ answers: { q: { type: 'noul', noul: 1 } }, usage: {} }), { status: 200 })
    },
    async () => {
      const result = await tool.execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })
      assert.equal(seen.length, 1)
      assert.equal(seen[0].authorization, 'Bearer from-store')
      assert.equal(seen[0].url, 'https://ai-gateway.vercel.sh/typesafe/v1/systemone')
      assert.equal(result.answers.q.noul, 1)
    },
  )
})

test('the jev tool reads the credentials service lazily, per call', async () => {
  const saved = process.env.TYPESAFE_API_KEY
  delete process.env.TYPESAFE_API_KEY
  let service
  const tool = makeTool(
    () => service,
    () => ({ provider: 'typesafe' }),
  )
  await withFetchStub(
    async () => new Response(JSON.stringify({ answers: {} }), { status: 200 }),
    async () => {
      // The service has not mounted yet: the call must fail loudly, not silently.
      await assert.rejects(
        tool.execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } }),
        /no API key/,
      )
      // It mounts afterwards (cross-bundle order): the next call must see it.
      service = { resolve: async () => ({ value: 'late' }) }
      await tool.execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })
    },
  )
  if (saved === undefined) delete process.env.TYPESAFE_API_KEY
  else process.env.TYPESAFE_API_KEY = saved
})

test('the jev tool still reports a genuinely missing key', async () => {
  const saved = process.env.TYPESAFE_API_KEY
  delete process.env.TYPESAFE_API_KEY
  const tool = makeTool(
    () => ({ resolve: async () => undefined }),
    () => ({ provider: 'typesafe' }),
  )
  await assert.rejects(
    tool.execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } }),
    /no API key for provider "typesafe"/,
  )
  if (saved === undefined) delete process.env.TYPESAFE_API_KEY
  else process.env.TYPESAFE_API_KEY = saved
})

test('a blank stored key fails with "no API key", not an opaque 401', async () => {
  const saved = process.env.TYPESAFE_API_KEY
  delete process.env.TYPESAFE_API_KEY
  try {
    const tool = makeTool(
      () => ({ resolve: async () => ({ value: '   ' }) }),
      () => ({ provider: 'typesafe' }),
    )
    await withFetchStub(
      async () => {
        throw new Error('the request must not leave with a blank key')
      },
      async () => {
        await assert.rejects(
          tool.execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } }),
          /no API key for provider "typesafe"/,
        )
      },
    )
  } finally {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = saved
  }
})

test('the jev tool refuses a disabled tool and an oversized state', async () => {
  const disabled = makeTool(
    () => undefined,
    () => ({ enabled: false }),
  )
  await assert.rejects(
    disabled.execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } }),
    /disabled in Settings/,
  )
  const tool = makeTool(
    () => undefined,
    () => ({ maxStateChars: 3 }),
  )
  await assert.rejects(
    tool.execute({ state: 'too long', questions: { q: { type: 'noul', instructions: 'x' } } }),
    /this plugin allows 3/,
  )
})

test('callJev sends the TypeSafe body shape', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ model: 'jev-latest', answers: {}, usage: {} }), { status: 200 })
  }
  await callJev({
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    apiKey: 'k',
    state: 'hello',
    questions: { q: { type: 'noul', instructions: 'x' } },
    fetchImpl,
  })
  assert.equal(seen.url, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(seen.init.headers.authorization, 'Bearer k')
  assert.equal(seen.body.model, 'jev-latest')
  assert.equal(seen.body.state, 'hello')
  assert.deepEqual(Object.keys(seen.body.questions), ['q'])
})

test('callJev retries a 429 and succeeds on the second attempt', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) {
      return new Response('{"error":"busy"}', { status: 429, headers: { 'retry-after': '0' } })
    }
    return new Response(JSON.stringify({ answers: { q: { type: 'noul', noul: 1 } } }), { status: 200 })
  }
  const payload = await callJev({
    url: 'https://x/v1/systemone',
    model: 'm',
    apiKey: 'k',
    state: 's',
    questions: { q: { type: 'noul', instructions: 'x' } },
    fetchImpl,
  })
  assert.equal(calls, 2)
  assert.equal(payload.answers.q.noul, 1)
})

test('callJev caps an absurd retry-after instead of freezing for hours', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    // A free tier can ask for a retry-after of hours. The call must fail within
    // a bounded time instead of hanging until that window expires.
    return new Response('{"error":"Rate limit exceeded"}', {
      status: 429,
      headers: { 'retry-after': '15366' },
    })
  }
  const started = Date.now()
  await assert.rejects(
    callJev({
      url: 'https://x/v1/systemone',
      model: 'jev-1.13-free',
      apiKey: 'k',
      state: 's',
      questions: { q: { type: 'noul', instructions: 'x' } },
      fetchImpl,
    }),
    /rate limit reached and the provider asks to retry in 257 min/,
  )
  const elapsed = Date.now() - started
  assert.equal(calls, 1, 'must not retry when the limit window is hours away')
  assert.ok(elapsed < 5_000, `must give up promptly, took ${elapsed}ms`)
})

test('a cancelled call stops retrying instead of sleeping the ladder', async () => {
  // Cancelled before the first request: nothing may leave.
  const pre = new AbortController()
  pre.abort()
  let calls = 0
  await assert.rejects(
    callJev({
      url: 'https://x/v1/systemone',
      model: 'm',
      apiKey: 'k',
      state: 's',
      questions: { q: { type: 'noul', instructions: 'x' } },
      signal: pre.signal,
      fetchImpl: async () => {
        calls += 1
        return new Response('{}', { status: 200 })
      },
    }),
    /jev request cancelled/,
  )
  assert.equal(calls, 0, 'no request may leave after the caller cancelled')

  // Cancelled while the 429 backoff sleeps: the turn must not wait it out
  // (the ladder totals 52s; a cancelled tool must be gone almost at once).
  const during = new AbortController()
  calls = 0
  const started = Date.now()
  await assert.rejects(
    callJev({
      url: 'https://x/v1/systemone',
      model: 'm',
      apiKey: 'k',
      state: 's',
      questions: { q: { type: 'noul', instructions: 'x' } },
      signal: during.signal,
      fetchImpl: async () => {
        calls += 1
        setTimeout(() => during.abort(), 10)
        return new Response('{"error":"busy"}', { status: 429 })
      },
    }),
    /jev request cancelled/,
  )
  const elapsed = Date.now() - started
  assert.equal(calls, 1, 'must not issue another request after the caller cancelled')
  assert.ok(elapsed < 900, `the cancel must cut the 1s backoff short, took ${elapsed}ms`)
})

test('the API key never reaches an error message or a ledger record', async () => {
  const apiKey = 'sk-live-4f8a2c9e01bd7735'
  const questions = { q: { type: 'noul', instructions: 'x' } }
  const echo = async () =>
    new Response(JSON.stringify({ error: `unauthorized header: Bearer ${apiKey}` }), { status: 400 })

  // The helper itself: redact real keys, leave short needles untouched.
  assert.equal(redactSecret('Bearer sk-live-4f8a2c9e01bd7735 rejected', apiKey), 'Bearer [redacted] rejected')
  assert.equal(redactSecret('Chec[k] the API key', 'k'), 'Chec[k] the API key')
  assert.equal(redactSecret(undefined, apiKey), '')

  // An endpoint echoing the request header: the thrown message must be clean.
  await assert.rejects(
    callJev({
      url: 'https://x/v1/systemone',
      model: 'm',
      apiKey,
      state: 's',
      questions,
      fetchImpl: echo,
    }),
    (error) => {
      assert.match(error.message, /HTTP 400/)
      assert.match(error.message, /\[redacted\]/)
      assert.ok(!error.message.includes(apiKey), 'the key leaked into the error')
      return true
    },
  )

  // …and so must the string the tool persists to the ledger on disk.
  const records = []
  const tool = makeTool(
    () => ({ resolve: async () => ({ value: apiKey }) }),
    () => ({ provider: 'typesafe', dailyCallLimit: 0, dailyTokenLimit: 0 }),
    () => ({ summary: () => ({ calls: 0, failures: 0, inputTokens: 0 }), append: (r) => records.push(r) }),
  )
  await withFetchStub(echo, async () => {
    await assert.rejects(tool.execute({ state: 's', questions }), /HTTP 400/)
  })
  assert.equal(records.length, 1)
  assert.match(records[0].error, /\[redacted\]/)
  assert.ok(!records[0].error.includes(apiKey), 'the key leaked into the ledger record')

  // A network failure is retried, so reach its report through the cancellation
  // path: the caller aborts during the backoff and the quote must be redacted.
  const controller = new AbortController()
  await assert.rejects(
    callJev({
      url: 'https://x/v1/systemone',
      model: 'm',
      apiKey,
      state: 's',
      questions,
      signal: controller.signal,
      fetchImpl: async () => {
        setTimeout(() => controller.abort(), 10)
        throw new Error(`proxy refused Bearer ${apiKey}`)
      },
    }),
    (error) => {
      assert.match(error.message, /jev request cancelled/)
      assert.match(error.message, /\[redacted\]/)
      assert.ok(!error.message.includes(apiKey), 'the key leaked into the network error')
      return true
    },
  )
})

test('callJev does not retry a 400', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return new Response('{"message":"bad question"}', { status: 400 })
  }
  await assert.rejects(
    callJev({
      url: 'https://x/v1/systemone',
      model: 'm',
      apiKey: 'k',
      state: 's',
      questions: { q: { type: 'noul', instructions: 'x' } },
      fetchImpl,
    }),
    /HTTP 400/,
  )
  assert.equal(calls, 1)
})

test('callJev explains a rejected credential in terms the model can relay', async () => {
  const fetchImpl = async () => new Response('{"error":"invalid key"}', { status: 401 })
  await assert.rejects(
    callJev({
      url: 'https://x/v1/systemone',
      model: 'm',
      apiKey: 'bad',
      state: 's',
      questions: { q: { type: 'noul', instructions: 'x' } },
      fetchImpl,
    }),
    /Settings → Jev/,
  )
})

test('the retry ladder is bounded and increasing', () => {
  assert.ok(RETRY_DELAYS_MS.length >= 3 && RETRY_DELAYS_MS.length <= 6)
  for (let i = 1; i < RETRY_DELAYS_MS.length; i++) {
    assert.ok(RETRY_DELAYS_MS[i] > RETRY_DELAYS_MS[i - 1])
  }
})

test('isLoopbackRequest accepts only loopback peers', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '192.0.2.10' } }), false)
  assert.equal(isLoopbackRequest({ socket: {} }), false)
  assert.equal(isLoopbackRequest({}), false)
})

test('the describe bridge never ships a legacy settings apiKey to the browser', async () => {
  const routes = makeBridgeRoutes({
    getSettings: () => null,
    getConfig: () => ({
      enabled: true,
      provider: 'typesafe',
      model: '',
      baseUrl: '',
      apiKey: 'sk-legacy-in-settings-123456',
    }),
    getCredentials: () => null,
    getLedger: () => null,
    probe: async () => ({}),
  })
  const describe = routes.find((route) => route.path.endsWith('/describe'))
  assert.ok(describe, 'the describe route is registered')

  let body = ''
  const req = { method: 'POST', socket: { remoteAddress: '127.0.0.1' } }
  const res = {
    writeHead: () => {},
    end: (chunk) => {
      body = String(chunk)
    },
  }
  await describe.handler(req, res)

  const view = JSON.parse(body)
  assert.equal(view.ok, true)
  assert.ok(!body.includes('sk-legacy-in-settings-123456'), 'the legacy key leaked into the describe payload')
  assert.equal(view.value.value.provider, 'typesafe', 'ordinary config values still travel')
})

test('every provider declares a credential name and a URL (except custom)', () => {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    assert.equal(provider.id, id)
    assert.ok(provider.credential.length > 0, `${id} needs a credential name`)
    assert.ok(provider.label.length > 0, `${id} needs a label`)
    if (id !== 'custom') assert.match(provider.url, /^https:\/\//, `${id} needs an https URL`)
  }
})

// ------------------------------------------------------------- OpenCode Zen

test('resolveEndpoint resolves opencode-zen to the Zen systemone contract', () => {
  const endpoint = resolveEndpoint({ provider: 'opencode-zen' })
  assert.equal(endpoint.error, undefined)
  assert.equal(endpoint.url, 'https://opencode.ai/zen/v1/systemone')
  assert.equal(endpoint.credential, 'OPENCODE_ZEN_API_KEY')
  assert.equal(endpoint.model, 'jev-1.13', 'the paid checkpoint, not the free one')
  // A model override can still pin another Zen checkpoint.
  assert.equal(resolveEndpoint({ provider: 'opencode-zen', model: 'jev-1.13-free' }).model, 'jev-1.13-free')
})

test('callJev sends the Zen model in the body, not as a query param', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ answers: {}, usage: {} }), { status: 200 })
  }
  const endpoint = resolveEndpoint({ provider: 'opencode-zen' })
  await callJev({
    url: endpoint.url,
    model: endpoint.model,
    apiKey: 'k',
    state: 'hola',
    questions: { q1: { type: 'noul', instructions: '¿ok?' } },
    fetchImpl,
  })
  assert.equal(seen.url, 'https://opencode.ai/zen/v1/systemone')
  assert.equal(seen.init.headers.authorization, 'Bearer k')
  assert.equal(seen.body.model, 'jev-1.13')
  assert.equal(seen.body.state, 'hola')
})

// ---------------------------------------------------------------- Laya Studio

test('resolveEndpoint resolves laya-studio with its own model and price', () => {
  const endpoint = resolveEndpoint({ provider: 'laya-studio' })
  assert.equal(endpoint.error, undefined)
  assert.equal(endpoint.url, 'https://api.laya.studio/v1/systemone')
  assert.equal(endpoint.credential, 'LAYA_API_KEY')
  assert.equal(endpoint.model, '', 'an empty model keeps Laya routing')
  assert.equal(endpoint.pricePerMtok, 0.0294)
  assert.deepEqual(endpoint.limits, { maxQuestions: 32, maxOptions: 64 })
  // A model override can still pin one checkpoint.
  assert.equal(resolveEndpoint({ provider: 'laya-studio', model: 'multilingual' }).model, 'multilingual')
})

test('callJev omits the model field only when it is empty', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ answers: {}, usage: {} }), { status: 200 })
  }
  await callJev({
    url: 'https://api.laya.studio/v1/systemone', model: '', apiKey: 'k',
    state: 's', questions: { q: { type: 'noul', instructions: 'x' } }, fetchImpl,
  })
  assert.equal('model' in seen[0], false, 'omitted model keeps Laya\'s own routing')
  await callJev({
    url: 'https://api.laya.studio/v1/systemone', model: 'multilingual', apiKey: 'k',
    state: 's', questions: { q: { type: 'noul', instructions: 'x' } }, fetchImpl,
  })
  assert.equal(seen[1].model, 'multilingual')
})

test('validateQuestions caps options per question and names the bound', () => {
  const make = (n) => {
    const criteria = {}
    for (let i = 0; i < n; i++) criteria[`o${i}`] = 'option'
    return { q: { type: 'choice', instructions: 'x', criteria } }
  }
  // No cap by default: 100 options still validates.
  assert.equal(validateQuestions(make(100), 200, 0).q.type, 'choice')
  // Exactly at the cap passes; one over it is refused by name.
  assert.equal(validateQuestions(make(64), 200, 64).q.type, 'choice')
  assert.throws(
    () => validateQuestions(make(65), 200, 64, 'the laya-studio provider'),
    /questions\.q\.criteria has 65 options; the laya-studio provider allows 64/,
  )
})

test('the tool applies the provider question cap before any request', async () => {
  const original = globalThis.fetch
  let called = 0
  globalThis.fetch = async () => { called++; return new Response('{}', { status: 200 }) }
  try {
    const tool = makeTool(
      () => ({ resolve: async () => ({ value: 'k' }) }),
      () => ({ provider: 'laya-studio' }),
    )
    const questions = {}
    for (let i = 0; i < 33; i++) questions[`q${i}`] = { type: 'noul', instructions: 'x' }
    await assert.rejects(
      tool.execute({ state: 's', questions }),
      /too many questions \(33\); the laya-studio provider allows 32/,
    )
    assert.equal(called, 0, 'a request the provider would reject must not leave')
  } finally {
    globalThis.fetch = original
  }
})

test('a laya-studio call is recorded at the laya rate, attributed to auto', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(
    JSON.stringify({ answers: { q: { type: 'noul', noul: 1 } }, usage: { input_tokens: 1_000_000 } }),
    { status: 200 },
  )
  try {
    const { Ledger } = await import('../lib/ledger.js')
    const ledger = new Ledger('')
    const tool = makeTool(
      () => ({ resolve: async () => ({ value: 'k' }) }),
      () => ({ provider: 'laya-studio' }),
      () => ledger,
    )
    await tool.execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })
    const rec = ledger.records[0]
    assert.equal(rec.provider, 'laya-studio')
    assert.equal(rec.usdPerMtok, 0.0294)
    // The response carried no model, so the record keeps the routing label.
    assert.equal(rec.model, 'auto')
    assert.equal(ledger.summary().costUsd.toFixed(4), '0.0294')
  } finally {
    globalThis.fetch = original
  }
})
