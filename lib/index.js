/**
 * dsh-jev-plugin — ask Jev (TypeSafe System One) typed questions from DeepSeek Harness.
 *
 * The model returns judgements, not prose: every question is evaluated in
 * parallel against the same state, so a request carrying 50 questions costs
 * about the same and takes about as long as one carrying 1.
 *
 * This half owns the tool, the settings namespace and the Settings bridge.
 * Each user brings their own key: it is written to the DSH credentials store
 * (not to settings.yaml), and may also come from the provider's environment
 * variable. The provider is chosen in Settings and decides endpoint + model.
 *
 * @module dsh-jev-plugin
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import z from '@deepseek-ai/schemastery'

import { Ledger, costUsd } from './ledger.js'

export const name = 'jev'
export const inject = ['tools']

/** Settings namespace owned by this plugin. */
export const NS = 'jev'
/** Same-origin bridge the browser half calls; loopback-only. */
export const BRIDGE_PREFIX = '/api/dsh-jev-settings'

const MAX_JSON_BODY_BYTES = 1 << 20
const QUESTION_TYPES = ['noul', 'choice', 'score']

/**
 * Supported providers. Jev is served by TypeSafe directly, or through Vercel's
 * AI Gateway (which exposes a TypeSafe-compatible endpoint), or by any endpoint
 * that implements the same `POST /v1/systemone` contract. Laya Studio is a
 * different model speaking that same wire: the same question types and answer
 * shape, but it ignores Jev model ids (its router picks a checkpoint), it
 * publishes lower limits and a lower price — which is why a provider can carry
 * its own `limits` and `pricePerMtok`.
 *
 * `credential` is the credentials-store key AND the env fallback name: the same
 * string is used for both, so a user who already exported TYPESAFE_API_KEY
 * needs to configure nothing.
 */
export const PROVIDERS = {
  typesafe: {
    id: 'typesafe',
    label: 'TypeSafe (direct)',
    url: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-latest',
    credential: 'TYPESAFE_API_KEY',
    keyHint: 'console.typesafe.ai → API keys',
  },
  'vercel-gateway': {
    id: 'vercel-gateway',
    label: 'Vercel AI Gateway',
    url: 'https://ai-gateway.vercel.sh/typesafe/v1/systemone',
    model: 'typesafe-ai/jev',
    credential: 'AI_GATEWAY_API_KEY',
    keyHint: 'Vercel → AI Gateway → API keys (vck_…)',
  },
  'laya-studio': {
    id: 'laya-studio',
    label: 'Laya Studio',
    url: 'https://api.laya.studio/v1/systemone',
    // An empty model omits the field from the request. Laya ignores Jev model
    // ids and routes to its own checkpoints; an override can still pin
    // 'english', 'multilingual' or 'typed-decisions'.
    model: '',
    credential: 'LAYA_API_KEY',
    keyHint: 'laya.studio → dashboard → API keys (lsk_...)',
    modelHint: 'automatic routing (a Jev model id is accepted and ignored)',
    // Published limits: 32 questions per request, 64 options per question.
    // The state is read per question — 512 tokens on the English checkpoint,
    // 1,024 on the multilingual and typed-decisions ones — and longer states
    // are silently truncated. https://laya.studio/docs/errors
    limits: { maxQuestions: 32, maxOptions: 64 },
    // List price: $0.0294 per 1M input tokens, 30% below Jev's $0.042.
    pricePerMtok: 0.0294,
    note:
      'Open model, hosted independently in Switzerland. Reads only the first '
      + '512 (English) / 1,024 (multilingual) tokens per question — put the decisive '
      + 'text first. Best below ~20 options per choice. Its confidence is computed '
      + 'differently from Jev, so thresholds do not carry over.',
  },
  'opencode-zen': {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    url: 'https://opencode.ai/zen/v1/systemone',
    // Zen serves the same POST /v1/systemone contract as TypeSafe, so the request
    // shape needs no translation. `jev-1.13` is the paid Jev checkpoint; there is
    // also a `jev-1.13-free`, but Zen only honours free models from inside the
    // OpenCode client (it answers 403 "free tier can only be used from within
    // OpenCode"), so it is useless from here.
    model: 'jev-1.13',
    credential: 'OPENCODE_ZEN_API_KEY',
    keyHint: 'opencode.ai → Zen → API keys (the same account key also lists /zen/v1/models)',
    note:
      'Requires a funded Zen account: until then Zen answers 402 "Insufficient account '
      + 'funds". The free checkpoint cannot be used from DSH.',
  },
  custom: {
    id: 'custom',
    label: 'Custom TypeSafe-compatible endpoint',
    url: '',
    model: 'jev-latest',
    credential: 'JEV_API_KEY',
    keyHint: 'any endpoint implementing POST /v1/systemone',
  },
}

/** Provider ids accepted by the settings field. */
export const PROVIDER_IDS = Object.keys(PROVIDERS)

/** Loader schema. Secrets never live here; the key goes to the credentials store. */
export const Config = z.object({
  enabled: z.boolean().default(true),
  provider: z.string().default('typesafe'),
  model: z.string(),
  baseUrl: z.string(),
  timeoutMs: z.number().default(60000),
  maxStateChars: z.number().default(40000),
  maxQuestions: z.number().default(200),
  /** Where the judgment ledger lives; empty means <DSH_HOME>/dsh-jev. */
  dataDir: z.string(),
  /** Judgments allowed per local day. 0 disables the cap. */
  dailyCallLimit: z.number().default(500),
  /** Input tokens allowed per local day. 0 disables the cap. */
  dailyTokenLimit: z.number().default(5000000),
})

/** Default ledger directory: the harness home when it is set, else ~/.dsh. */
export function defaultDataDir(env = process.env) {
  const home = String(env?.DSH_HOME ?? '').trim()
  return join(home.length > 0 ? home : join(homedir(), '.dsh'), 'dsh-jev')
}

/** Resolved endpoint for the configured provider, or a descriptive error. */
export function resolveEndpoint(config) {
  const cfg = config ?? {}
  const id = typeof cfg.provider === 'string' && cfg.provider.length > 0 ? cfg.provider : 'typesafe'
  const provider = PROVIDERS[id]
  if (provider === undefined) {
    return {
      error: `unknown provider "${id}"; expected one of ${PROVIDER_IDS.join(', ')}`,
    }
  }
  const url = id === 'custom' ? String(cfg.baseUrl ?? '').trim() : provider.url
  if (url.length === 0) {
    return { error: 'the custom provider needs a base URL (Settings → Jev → Base URL)' }
  }
  if (!/^https?:\/\//.test(url)) {
    return { error: `base URL must start with http:// or https:// (got "${url}")` }
  }
  const model = String(cfg.model ?? '').trim() || provider.model
  return {
    id,
    url,
    model,
    credential: provider.credential,
    limits: provider.limits ?? null,
    pricePerMtok: provider.pricePerMtok ?? null,
  }
}

/**
 * Validate the caller's question map. Returns a normalised map or throws with a
 * message that names the offending path, so a bad question surfaces as a tool
 * error the model can act on rather than as a provider rejection.
 */
export function validateQuestions(questions, maxQuestions = 200, maxOptions = 0, scope = 'this plugin') {
  if (questions === null || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new Error('`questions` must be an object of {type, instructions, criteria?}')
  }
  const names = Object.keys(questions)
  if (names.length === 0) throw new Error('at least one question is required')
  if (names.length > maxQuestions) {
    throw new Error(`too many questions (${names.length}); ${scope} allows ${maxQuestions}`)
  }
  const out = {}
  for (const key of names) {
    const q = questions[key]
    if (q === null || typeof q !== 'object' || Array.isArray(q)) {
      throw new Error(`questions.${key} must be an object`)
    }
    if (!QUESTION_TYPES.includes(q.type)) {
      throw new Error(
        `questions.${key}.type: expected one of 'noul', 'choice', 'score' (got ${JSON.stringify(q.type)})`,
      )
    }
    const instructions = q.instructions
    if (typeof instructions !== 'string' || instructions.trim().length === 0) {
      // A missing, blank or non-string `instructions` is a provider 400 (or a
      // paid call that judges nothing): refuse it here, naming the path.
      const shown = instructions === undefined ? 'undefined' : String(JSON.stringify(instructions)).slice(0, 60)
      throw new Error(`questions.${key}.instructions must be a non-empty string (got ${shown})`)
    }
    const entry = { type: q.type, instructions }
    if (q.type === 'choice') {
      if (q.criteria === null || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) {
        throw new Error(`questions.${key}.criteria must be an object of label → description for a choice`)
      }
      if (Object.keys(q.criteria).length < 2) {
        throw new Error(`questions.${key}.criteria needs at least two options`)
      }
      if (maxOptions > 0 && Object.keys(q.criteria).length > maxOptions) {
        throw new Error(
          `questions.${key}.criteria has ${Object.keys(q.criteria).length} options; ${scope} allows ${maxOptions}`,
        )
      }
      entry.criteria = q.criteria
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
        throw new Error(
          `questions.${key}.criteria must be an array of at least two ordered labels for a score`,
        )
      }
      entry.criteria = q.criteria
    } else if (q.criteria !== undefined && q.criteria !== null) {
      entry.criteria = q.criteria
    }
    // defineProperty, not `out[key] = entry`: a question literally named
    // `__proto__` (a plausible name in a JSON blob under judgement) would hit
    // Object.prototype's setter, change the prototype and silently drop the
    // question — the model would get "(no answer)" or a puzzling 400.
    Object.defineProperty(out, key, {
      value: entry,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

/** One human-readable line per answer, plus a usage footer. */
export function formatAnswers(payload, names) {
  const answers = payload?.answers ?? {}
  const lines = []
  for (const key of names) {
    const a = answers[key]
    if (a === undefined) {
      lines.push(`${key}: (no answer)`)
    } else if (a.type === 'noul') {
      lines.push(`${key}: ${a.noul}${a.noul >= 0.5 ? ' (yes)' : ' (no)'}`)
    } else if (a.type === 'choice') {
      lines.push(`${key}: ${a.choice} | confidence ${a.confidence} | ${JSON.stringify(a.probabilities)}`)
    } else if (a.type === 'score') {
      lines.push(`${key}: ${a.score} | confidence ${a.confidence} | ${JSON.stringify(a.probabilities)}`)
    } else {
      lines.push(`${key}: ${JSON.stringify(a)}`)
    }
  }
  const usage = payload?.usage ?? {}
  const inputTokens = usage.input_tokens ?? usage.inputTokens
  const model = payload?.model ?? '?'
  lines.push(`--- ${names.length} questions | ${inputTokens} input tokens | model ${model}`)
  return lines.join('\n')
}

/**
 * Retry policy for the upstream. Jev answers 429 under load ("the upstream
 * provider is currently experiencing high demand"), which is common enough that
 * a single attempt is not viable for a tool that runs inside a turn.
 */
export const RETRY_DELAYS_MS = [1000, 3000, 8000, 15000, 25000]
/** Ceiling on a retry wait: a server's `retry-after` may not exceed this. */
export const RETRY_AFTER_CAP_MS = 30000

/**
 * Strip the API key from text that is about to leave `callJev`.
 *
 * Error strings are shown to the model, returned by the Settings bridge and
 * appended to the ledger on disk, so a key that appears inside one of them (an
 * endpoint echoing the request header, a fetch error quoting it) would land in
 * the transcript and in a file. Below 8 characters there is nothing worth
 * protecting: a shorter needle would only mangle the message.
 */
export function redactSecret(text, secret) {
  const out = String(text ?? '')
  const key = typeof secret === 'string' ? secret.trim() : ''
  return key.length >= 8 ? out.split(key).join('[redacted]') : out
}

/** Backoff sleep that wakes early when the caller's signal aborts. */
function waitRetry(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * A cancelled call must say it was cancelled — not that it "timed out" — and
 * must quote the last attempt without leaking the key into it.
 */
function cancelledError(lastError) {
  const why = lastError && lastError !== 'no attempt was made' ? ` (last attempt: ${lastError})` : ''
  return new Error(`jev request cancelled: the caller aborted the execution${why}`)
}

/** POST the questions and return the parsed TypeSafe payload. */
export async function callJev({ url, model, apiKey, state, questions, timeoutMs, signal, fetchImpl }) {
  const doFetch = fetchImpl ?? globalThis.fetch
  // An empty model omits the field entirely: Jev requires it, Laya documents
  // omission as the way to keep its own routing.
  const body = JSON.stringify(model ? { model, state, questions } : { state, questions })
  let lastError = 'no attempt was made'
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    // The caller cancelled (or starts cancelled): no request leaves, and the
    // backoff sleeps above must not keep the turn alive on their own.
    if (signal?.aborted) throw cancelledError(lastError)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 60000))
    const relay = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', relay, { once: true })
    }
    let response
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: controller.signal,
      })
    } catch (error) {
      // An external abort is a cancellation, not a timeout: say so and stop
      // instead of sleeping the remaining ladder. Anything else is redacted
      // before it can reach the message, the ledger or the bridge.
      if (signal?.aborted) throw cancelledError(redactSecret(String(error?.message ?? error), apiKey))
      lastError = controller.signal.aborted
        ? 'the request timed out'
        : redactSecret(String(error?.message ?? error), apiKey)
      if (attempt < RETRY_DELAYS_MS.length) {
        await waitRetry(RETRY_DELAYS_MS[attempt], signal)
        continue
      }
      throw new Error(`jev request failed: ${lastError}`)
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', relay)
    }

    const text = await response.text()
    if (response.ok) {
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(redactSecret(`jev returned a non-JSON body: ${text.slice(0, 200)}`, apiKey))
      }
    }
    lastError = redactSecret(`HTTP ${response.status}: ${text.slice(0, 300)}`, apiKey)
    const retryable = response.status === 429 || response.status >= 500
    const after = Number(response.headers.get('retry-after')) * 1000
    // A free-tier 429 can carry a retry-after measured in hours (OpenCode Zen
    // sent 15366s). Honouring it literally freezes the session and looks like a
    // hang, so a retry-after over the budget gives up right away, naming the
    // wait, instead of leaving the agent waiting without a word.
    if (Number.isFinite(after) && after > RETRY_AFTER_CAP_MS) {
      throw new Error(
        `jev rate limit reached and the provider asks to retry in `
        + `${Math.ceil(after / 60_000)} min, so this call is not retried `
        + `(cap ${RETRY_AFTER_CAP_MS / 1000}s). Last response: ${lastError}`,
      )
    }
    if (retryable && attempt < RETRY_DELAYS_MS.length) {
      const wait = Number.isFinite(after) && after > 0 ? after : RETRY_DELAYS_MS[attempt]
      await waitRetry(Math.min(wait, RETRY_AFTER_CAP_MS), signal)
      continue
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `jev rejected the credential (${lastError}). Check the API key for the selected provider in Settings → Jev.`,
      )
    }
    throw new Error(`jev request failed: ${lastError}`)
  }
  throw new Error(`jev request failed after retries: ${lastError}`)
}

const TOOL_DESCRIPTION = [
  'Ask Jev, a fast decision model, one or more typed questions about a block of text and get structured answers with probabilities.',
  'It returns judgements, not prose: every question is evaluated in parallel against the same state, so a request carrying 50 questions costs about the same and takes about as long as one carrying 1.',
  'USE THIS when you must make the same kind of call about MANY items at once - log lines, tool outputs, test failures, search results, candidate files, review comments - instead of pulling them all into your own context or spawning a subagent to read them.',
  'Also useful as a cheap second opinion before an irreversible action, or to grade options against a rubric.',
  'WHEN NOT TO USE: to write, summarise, translate or reformat text (it cannot generate); for exact string or arithmetic work (it is not a regex engine or calculator); or for anything needing extended multi-step reasoning - decompose into atomic questions instead.',
  'Question types: {type:"noul", instructions} answers yes/no as `noul`, the probability of yes, 0-1. {type:"choice", instructions, criteria:{label: description}} picks one option and returns `choice`, `probabilities`, `confidence`. {type:"score", instructions, criteria:["low","mid","high"]} rates on an ordered rubric and returns `score`, `probabilities`, `confidence`.',
  'Write the instructions and criteria in English; the state may be in any language.',
  'Reference items by a stable label inside the state (for example "### ITEM 7") and ask one atomic question per item; a question about a whole document invites a guess.',
  'Read `probabilities` when `confidence` is low: a flat distribution means it is guessing. Values between roughly 0.4 and 0.6 on a noul carry little information.',
  'The answers are only as good as the questions you wrote: a badly scoped question returns a badly scoped answer.',
  'The endpoint, model and API key come from the user\'s Settings → Jev; when the tool reports a credential or configuration problem, tell the user to open that page.',
].join(' ')

/**
 * Build the model-facing tool schema.
 *
 * `getCredentials` is the lazy accessor, not the credentials service itself:
 * the service can mount after this plugin (cross-bundle order), so the tool
 * reads it on every call. Passing the service here instead of the accessor
 * made every call fail with "no API key" — `resolve` is undefined on a
 * function, and that throw is swallowed by the resolution fallback chain.
 */
export function makeTool(getCredentials, getConfig, getLedger) {
  return {
    name: 'jev',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          description:
            'The text to judge. Plain text, or a JSON string if the material is structured. Label items ("> ## ITEM 3") when asking per-item questions.',
        },
        questions: {
          type: 'object',
          description:
            'Questions keyed by the name you want back in `answers`. Each value is {type:"noul"|"choice"|"score", instructions, criteria?}. `criteria` is required for choice (an object of label to description) and score (an array of at least two ordered labels). Example: {"item3_failed":{"type":"noul","instructions":"Does ITEM 3 report a failure?"}}',
          additionalProperties: true,
        },
      },
      required: ['state', 'questions'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cfg = getConfig()
      if (cfg?.enabled === false) {
        throw new Error('the jev tool is disabled in Settings → Jev')
      }
      const state = args?.state
      if (typeof state !== 'string' || state.length === 0) {
        throw new Error('`state` must be a non-empty string')
      }
      const maxStateChars = Number(cfg?.maxStateChars) || 40000
      if (state.length > maxStateChars) {
        throw new Error(
          `state is ${state.length} characters; this plugin allows ${maxStateChars}. Split it into several calls.`,
        )
      }
      const endpoint = resolveEndpoint(cfg)
      if (endpoint.error) throw new Error(endpoint.error)

      // The tighter bound wins: the plugin's configured ceiling or the
      // provider's published limit. Laya Studio answers 33 questions with a
      // 400; refusing here turns that into a message naming the number.
      const limits = endpoint.limits ?? {}
      const maxQuestions = Math.min(Number(cfg?.maxQuestions) || 200, limits.maxQuestions ?? Infinity)
      const providerScope = limits.maxQuestions ?? 0
      const questions = validateQuestions(
        args?.questions,
        maxQuestions,
        limits.maxOptions ?? 0,
        providerScope ? `the ${endpoint.id} provider` : 'this plugin',
      )

      const apiKey = await resolveApiKey(getCredentials?.(), endpoint.credential, cfg?.apiKey)
      if (!apiKey) {
        throw new Error(
          `no API key for provider "${endpoint.id}". Open Settings → Jev and save one, or export ${endpoint.credential}.`,
        )
      }

      // Caps are checked before the request, against today's ledger. A judgment
      // is an optimisation; exceeding a budget must stop the spending, not the
      // session, so this refuses loudly with the number and the way to raise it.
      const ledger = getLedger?.()
      const callLimit = Number(cfg?.dailyCallLimit) || 0
      const tokenLimit = Number(cfg?.dailyTokenLimit) || 0
      if (ledger !== undefined && ledger !== null) {
        const usage = ledger.summary()
        if (callLimit > 0 && usage.calls >= callLimit) {
          throw new Error(
            `the daily judgment cap is reached (${usage.calls}/${callLimit} calls today). ` +
            'Raise dailyCallLimit in Settings → Jev, or wait for tomorrow.',
          )
        }
        if (tokenLimit > 0 && usage.inputTokens >= tokenLimit) {
          throw new Error(
            `the daily token cap is reached (${usage.inputTokens.toLocaleString()}/` +
            `${tokenLimit.toLocaleString()} input tokens today). ` +
            'Raise dailyTokenLimit in Settings → Jev, or wait for tomorrow.',
          )
        }
      }

      const started = Date.now()
      const base = {
        provider: endpoint.id,
        model: endpoint.model || 'auto',
        chars: state.length,
        questions: Object.keys(questions).length,
        // Priced at the rate this provider publishes, not the ledger's default.
        ...(endpoint.pricePerMtok ? { usdPerMtok: endpoint.pricePerMtok } : {}),
      }
      let payload
      try {
        payload = await callJev({
          url: endpoint.url,
          model: endpoint.model,
          apiKey,
          state,
          questions,
          timeoutMs: Number(cfg?.timeoutMs) || 60000,
          signal: exec?.signal,
        })
      } catch (error) {
        ledger?.append({
          ...base,
          ok: false,
          ms: Date.now() - started,
          error: String(error?.message ?? error).slice(0, 200),
        })
        throw error
      }
      const usage = payload?.usage ?? {}
      ledger?.append({
        ...base,
        ok: true,
        model: payload?.model ?? base.model,
        inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
        outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
        ms: Date.now() - started,
      })
      return { text: formatAnswers(payload, Object.keys(questions)), answers: payload.answers ?? {} }
    },
  }
}

/**
 * Credentials-first, then the legacy settings field, then the environment.
 * The credentials store is DSH's own secret home, so it wins.
 *
 * Every candidate is trimmed: a key pasted with a stray newline (a common
 * `.env` accident) would otherwise become an invalid header, and a
 * whitespace-only value must read as "not configured" so the caller can say so
 * instead of sending `Bearer    ` and surfacing an opaque 401.
 */
export async function resolveApiKey(credentials, credentialKey, settingsValue) {
  const norm = (value) => (typeof value === 'string' ? value.trim() : '')
  if (credentials !== undefined && credentials !== null) {
    try {
      const resolved = await credentials.resolve(credentialKey)
      const fromStore = norm(resolved?.value)
      if (fromStore) return fromStore
    } catch {
      // fall through: an unavailable store must not break an env-configured setup
    }
  }
  const fromSettings = norm(settingsValue)
  if (fromSettings) return fromSettings
  return norm(process.env[credentialKey])
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** The bridge is same-origin only; anything else must not read or write secrets. */
export function isLoopbackRequest(req) {
  const address = req?.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Settings + credentials bridge for the browser half.
 * Every route is POST, loopback-only, and shapes its own JSON.
 */
export function makeBridgeRoutes(deps) {
  const { getSettings, getConfig, getCredentials, getLedger, probe } = deps

  const guard = (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback requests only' })
      return false
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, code: 'method-not-allowed', message: `POST only (got ${req.method ?? ''})` })
      return false
    }
    return true
  }

  /**
   * One registered route: guard first, then the handler, whose own failures
   * must still answer in the bridge's JSON shape.
   *
   * The host's web server turns a rejected handler into an EMPTY 400 plus a
   * log line; the browser half then dies in `response.json()` and the card
   * shows a parse error instead of the reason. Answering `{ ok: false, code,
   * message }` keeps the contract the client already renders: JSON in, JSON
   * out, and no stack trace on the wire.
   */
  const route = (path, handler) => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      try {
        await handler(req, res)
      } catch (error) {
        // Every handler answers exactly once, at the end: if the response is
        // already on the wire there is nothing left to write.
        if (res.writableEnded) return
        writeJson(res, 500, {
          ok: false,
          code: 'internal-error',
          message: String(error?.message ?? error),
        })
      }
    },
  })

  /** Today's volume and spend, or null when accounting is unavailable. */
  const usageOf = () => {
    try {
      const ledger = getLedger?.()
      return ledger ? ledger.summary() : null
    } catch {
      return null
    }
  }

  const view = async () => {
    const settings = getSettings()
    const cfg = getConfig()
    const credentials = getCredentials()
    const descriptor = settings
      ?.describe?.({ redactSecrets: true })
      ?.find((candidate) => String(candidate.ns) === NS)
    const endpoint = resolveEndpoint(cfg)
    const credential = endpoint.credential ?? PROVIDERS.typesafe.credential
    // A legacy `apiKey` may live in settings.yaml (read by resolveApiKey, never
    // editable in the UI). The describe payload is a secret-free view by
    // construction: config values travel, secrets do not.
    const { apiKey: _legacyKey, ...value } = cfg ?? {}
    let keyConfigured = false
    if (credentials) {
      try {
        const info = await credentials.describe(credential)
        keyConfigured = info?.configured === true
      } catch {
        keyConfigured = false
      }
    }
    return {
      ns: NS,
      revision: descriptor?.revision ?? 0,
      value,
      providers: Object.values(PROVIDERS).map((p) => ({
        id: p.id,
        label: p.label,
        keyHint: p.keyHint,
        credential: p.credential,
        url: p.url,
        model: p.model,
        modelHint: p.modelHint ?? null,
        limits: p.limits ?? null,
        note: p.note ?? null,
      })),
      credential,
      keyConfigured,
      envFallback: process.env[credential] ? true : false,
      endpointError: endpoint.error ?? null,
      writable: settings?.writable !== false,
      usage: usageOf(),
    }
  }

  return [
    route(`${BRIDGE_PREFIX}/describe`, async (req, res) => {
      writeJson(res, 200, { ok: true, value: await view() })
    }),
    route(`${BRIDGE_PREFIX}/mutate`, async (req, res) => {
      const settings = getSettings()
      if (!settings) {
        writeJson(res, 200, { ok: false, code: 'settings-unavailable', message: 'the settings service is not available' })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined || !Array.isArray(body.ops)) {
        writeJson(res, 400, { ok: false, code: 'malformed', message: 'expected { ops: [...] }' })
        return
      }
      try {
        await settings.mutate(NS, body.ops, body.expectedRevision)
      } catch (error) {
        const conflict = error?.code === 'SETTINGS_CONFLICT'
        writeJson(res, 200, {
          ok: false,
          code: conflict ? 'settings-conflict' : 'settings-rejected',
          message: String(error?.message ?? error),
        })
        return
      }
      writeJson(res, 200, { ok: true, value: await view() })
    }),
    route(`${BRIDGE_PREFIX}/key-set`, async (req, res) => {
      const credentials = getCredentials()
      if (!credentials) {
        writeJson(res, 200, { ok: false, code: 'credentials-unavailable', message: 'the credentials service is not available' })
        return
      }
      const body = await readJsonBody(req)
      const value = typeof body?.value === 'string' ? body.value.trim() : ''
      if (value.length === 0) {
        writeJson(res, 400, { ok: false, code: 'malformed', message: 'value is required' })
        return
      }
      const endpoint = resolveEndpoint(getConfig())
      const ref = endpoint.credential ?? PROVIDERS.typesafe.credential
      try {
        await credentials.set(ref, value)
      } catch (error) {
        writeJson(res, 200, { ok: false, code: 'credentials-write-failed', message: String(error?.message ?? error) })
        return
      }
      writeJson(res, 200, { ok: true, value: await view() })
    }),
    route(`${BRIDGE_PREFIX}/key-unset`, async (req, res) => {
      const credentials = getCredentials()
      if (!credentials) {
        writeJson(res, 200, { ok: false, code: 'credentials-unavailable', message: 'the credentials service is not available' })
        return
      }
      const endpoint = resolveEndpoint(getConfig())
      const ref = endpoint.credential ?? PROVIDERS.typesafe.credential
      try {
        await credentials.unset(ref)
      } catch (error) {
        writeJson(res, 200, { ok: false, code: 'credentials-write-failed', message: String(error?.message ?? error) })
        return
      }
      writeJson(res, 200, { ok: true, value: await view() })
    }),
    route(`${BRIDGE_PREFIX}/usage`, async (req, res) => {
      const ledger = getLedger?.()
      if (!ledger) {
        writeJson(res, 200, { ok: false, code: 'no-ledger', message: 'the ledger is unavailable' })
        return
      }
      const body = await readJsonBody(req)
      if (body?.reset === true) ledger.reset()
      writeJson(res, 200, { ok: true, value: ledger.summary() })
    }),
    route(`${BRIDGE_PREFIX}/test`, async (req, res) => {
      try {
        writeJson(res, 200, { ok: true, value: await probe() })
      } catch (error) {
        writeJson(res, 200, { ok: false, code: 'probe-failed', message: String(error?.message ?? error) })
      }
    }),
  ]
}

export function apply(ctx, config) {
  let current = () => config ?? {}
  const logger = ctx.logger
  // The credentials service can mount after this plugin (cross-bundle order),
  // so read it lazily instead of caching it during apply.
  const getCredentials = () => ctx.get('credentials')

  // The data directory is a setting, so the ledger is rebuilt when it moves.
  // Read lazily for the same reason as the credentials service: it can mount
  // after this plugin.
  let ledger = null
  let ledgerPath = null
  const getLedger = () => {
    const dir = String(current()?.dataDir ?? '').trim() || defaultDataDir()
    const file = join(dir, 'ledger.jsonl')
    if (ledger === null || ledgerPath !== file) {
      ledger = new Ledger(file)
      ledgerPath = file
    }
    return ledger
  }

  const probe = async () => {
    const cfg = current()
    const endpoint = resolveEndpoint(cfg)
    if (endpoint.error) throw new Error(endpoint.error)
    const apiKey = await resolveApiKey(getCredentials(), endpoint.credential, cfg.apiKey)
    if (!apiKey) throw new Error(`no API key configured for "${endpoint.id}"`)
    const started = Date.now()
    const payload = await callJev({
      url: endpoint.url,
      model: endpoint.model,
      apiKey,
      state: 'The build failed with exit code 1.',
      questions: {
        passed: { type: 'noul', instructions: 'Did the build succeed?' },
        severity: {
          type: 'choice',
          instructions: 'How severe is this failure?',
          criteria: { none: 'no failure at all', fatal: 'the build did not produce output' },
        },
      },
      timeoutMs: Number(cfg?.timeoutMs) || 60000,
    })
    getLedger().append({
      ok: true,
      provider: endpoint.id,
      model: payload?.model ?? endpoint.model ?? 'auto',
      ...(endpoint.pricePerMtok ? { usdPerMtok: endpoint.pricePerMtok } : {}),
      chars: 0,
      questions: 2,
      inputTokens: payload?.usage?.input_tokens ?? payload?.usage?.inputTokens ?? 0,
      outputTokens: payload?.usage?.output_tokens ?? payload?.usage?.outputTokens ?? 0,
      ms: Date.now() - started,
      probe: true,
    })
    return {
      provider: endpoint.id,
      model: payload?.model ?? endpoint.model,
      latencyMs: Date.now() - started,
      inputTokens: payload?.usage?.input_tokens ?? payload?.usage?.inputTokens ?? null,
      answers: payload?.answers ?? {},
    }
  }

  ctx.inject(['settings'], (sctx) => {
    if (typeof sctx.settings.installSection !== 'function') {
      sctx.logger?.warn?.('jev: this dsh-settings build has no installSection; Settings → Jev will not appear')
      return
    }
    sctx.settings.installSection(ctx, NS, Config, config ?? {}, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {},
    })
  })

  ctx.inject(['webServer', 'settings'], (sctx) => {
    sctx.effect(() => {
      const disposers = makeBridgeRoutes({
        getSettings: () => sctx.settings,
        getConfig: () => current(),
        getCredentials,
        getLedger,
        probe,
      }).map((route) => sctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-jev: settings bridge')
  })

  ctx.inject(['tools'], (sctx) => {
    sctx.effect(() => sctx.tools.register(makeTool(getCredentials, () => current(), getLedger)), 'dsh-jev: tool')
    logger?.info?.('jev: the `jev` tool is registered')
  })
}

export default { name, inject, apply, Config }
