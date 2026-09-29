/**
 * Tests for the judgment ledger and the caps built on it.
 *
 * The ledger exists because a Jev call is invisible and not free — 11,377 input
 * tokens for one measured decision — so what matters here is that a call is
 * always recorded (including a failed one), that "today" is the local day, and
 * that a cap refuses loudly instead of spending.
 *
 * Run: node --test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Ledger, MAX_RECORDS, dayKey, costUsd, USD_PER_MTOK_INPUT } from '../lib/ledger.js'
import { defaultDataDir, makeTool } from '../lib/index.js'

const tmp = () => mkdtempSync(path.join(tmpdir(), 'jev-ledger-'))

test('costUsd bills input only, at the published rate', () => {
  assert.equal(costUsd(0), 0)
  assert.equal(costUsd(1_000_000), USD_PER_MTOK_INPUT)
  assert.equal(costUsd(11_377).toFixed(6), (11_377 / 1e6 * 0.042).toFixed(6))
  assert.equal(costUsd(undefined), 0)
  assert.equal(costUsd('nonsense'), 0)
})

test('dayKey uses the local day, not UTC', () => {
  const noon = new Date(2026, 8, 22, 12, 0, 0).getTime()
  assert.equal(dayKey(noon), '2026-09-22')
  const late = new Date(2026, 8, 22, 23, 59, 59).getTime()
  assert.equal(dayKey(late), '2026-09-22')
})

test('summary counts only today and prices it', () => {
  const dir = tmp()
  const file = path.join(dir, 'ledger.jsonl')
  const today = new Date(2026, 8, 22, 10, 0, 0).getTime()
  const yesterday = new Date(2026, 8, 21, 10, 0, 0).getTime()
  const ledger = new Ledger(file, { now: () => today })
  ledger.append({ ok: true, inputTokens: 1000, outputTokens: 10 })
  ledger.append({ ok: true, inputTokens: 2000, outputTokens: 20 })
  ledger.append({ ok: false, inputTokens: 500, error: 'HTTP 500' })
  // A record from yesterday must not count against today.
  ledger.records.push({ t: yesterday, ok: true, inputTokens: 9_000_000 })

  const s = ledger.summary(today)
  assert.equal(s.calls, 3)
  assert.equal(s.failures, 1)
  assert.equal(s.inputTokens, 3500)
  assert.equal(s.outputTokens, 30)
  assert.equal(s.costUsd.toFixed(8), costUsd(3500).toFixed(8))
  assert.equal(s.total.calls, 4)
  assert.equal(s.total.inputTokens, 9_003_500)
  rmSync(dir, { recursive: true, force: true })
})

test('the ledger survives a restart', () => {
  const dir = tmp()
  const file = path.join(dir, 'ledger.jsonl')
  const first = new Ledger(file)
  first.append({ ok: true, inputTokens: 42 })
  const second = new Ledger(file)
  assert.equal(second.summary().calls, 1)
  assert.equal(second.summary().inputTokens, 42)
  rmSync(dir, { recursive: true, force: true })
})

test('a torn last line does not take the ledger down', () => {
  const dir = tmp()
  const file = path.join(dir, 'ledger.jsonl')
  const ledger = new Ledger(file)
  ledger.append({ ok: true, inputTokens: 7 })
  // Simulate a crash mid-write.
  writeFileSync(file, readFileSync(file, 'utf8') + '{"t":123,"ok":true,"inputT')
  const reloaded = new Ledger(file)
  assert.equal(reloaded.summary().calls, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('reset empties the ledger in memory and on disk', () => {
  const dir = tmp()
  const file = path.join(dir, 'ledger.jsonl')
  const ledger = new Ledger(file)
  ledger.append({ ok: true, inputTokens: 100 })
  ledger.reset()
  assert.equal(ledger.summary().calls, 0)
  assert.equal(readFileSync(file, 'utf8'), '')
  assert.equal(new Ledger(file).summary().calls, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('a ledger that cannot persist still counts in memory', () => {
  // A path whose parent is a regular file: the directory cannot be prepared and
  // the ledger must degrade to memory-only rather than fail or block the call.
  // Deliberately NOT a /proc path: mkdirSync there blocks on this machine
  // instead of failing, which is exactly the hazard `prepare()` exists for.
  const dir = tmp()
  const blocker = path.join(dir, 'not-a-directory')
  writeFileSync(blocker, 'x')
  const ledger = new Ledger(path.join(blocker, 'ledger.jsonl'))
  assert.equal(ledger.persistent, false)
  ledger.append({ ok: true, inputTokens: 5 })
  assert.equal(ledger.summary().calls, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('the in-memory copy stays bounded', () => {
  const ledger = new Ledger('')
  for (let i = 0; i < MAX_RECORDS + 100; i++) ledger.append({ ok: true, inputTokens: 1 })
  assert.ok(ledger.records.length <= MAX_RECORDS)
})

test('defaultDataDir follows DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(defaultDataDir({ DSH_HOME: '/tmp/harness' }), path.join('/tmp/harness', 'dsh-jev'))
  assert.equal(defaultDataDir({}), path.join(process.env.HOME ?? '', '.dsh', 'dsh-jev'))
})

// ---------------------------------------------------------------- caps

/** A tool whose credentials always resolve, so only the cap can refuse. */
const toolWith = (ledger, cfg = {}) => makeTool(
  () => ({ resolve: async () => ({ value: 'k' }) }),
  () => ({ provider: 'typesafe', ...cfg }),
  () => ledger,
)

const okResponse = async () => new Response(
  JSON.stringify({ answers: { q: { type: 'noul', noul: 1 } }, usage: { input_tokens: 120, output_tokens: 4 } }),
  { status: 200 },
)

test('a successful call is recorded with its tokens', async () => {
  const original = globalThis.fetch
  globalThis.fetch = okResponse
  try {
    const ledger = new Ledger('')
    await toolWith(ledger, { dailyCallLimit: 0, dailyTokenLimit: 0 })
      .execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })
    const s = ledger.summary()
    assert.equal(s.calls, 1)
    assert.equal(s.inputTokens, 120)
    assert.equal(s.outputTokens, 4)
    assert.equal(s.failures, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('a failed call is recorded too, and still throws', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('{"error":"bad"}', { status: 400 })
  try {
    const ledger = new Ledger('')
    await assert.rejects(
      toolWith(ledger, { dailyCallLimit: 0, dailyTokenLimit: 0 })
        .execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } }),
      /HTTP 400/,
    )
    const s = ledger.summary()
    assert.equal(s.calls, 1)
    assert.equal(s.failures, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('the daily call cap refuses before spending anything', async () => {
  let called = 0
  const original = globalThis.fetch
  globalThis.fetch = async (...a) => { called++; return okResponse(...a) }
  try {
    const ledger = new Ledger('')
    ledger.append({ ok: true, inputTokens: 1 })
    ledger.append({ ok: true, inputTokens: 1 })
    await assert.rejects(
      toolWith(ledger, { dailyCallLimit: 2 })
        .execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } }),
      /daily judgment cap is reached \(2\/2 calls today\)/,
    )
    assert.equal(called, 0, 'no request may leave after the cap is hit')
  } finally {
    globalThis.fetch = original
  }
})

test('the daily token cap refuses before spending anything', async () => {
  let called = 0
  const original = globalThis.fetch
  globalThis.fetch = async (...a) => { called++; return okResponse(...a) }
  try {
    const ledger = new Ledger('')
    ledger.append({ ok: true, inputTokens: 5_000 })
    await assert.rejects(
      toolWith(ledger, { dailyTokenLimit: 5_000 })
        .execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } }),
      /daily token cap is reached \(5,000\/5,000 input tokens today\)/,
    )
    assert.equal(called, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('a cap of zero means no cap', async () => {
  const original = globalThis.fetch
  globalThis.fetch = okResponse
  try {
    const ledger = new Ledger('')
    for (let i = 0; i < 5; i++) ledger.append({ ok: true, inputTokens: 999_999 })
    await toolWith(ledger, { dailyCallLimit: 0, dailyTokenLimit: 0 })
      .execute({ state: 's', questions: { q: { type: 'noul', instructions: 'x' } } })
    assert.equal(ledger.summary().calls, 6)
  } finally {
    globalThis.fetch = original
  }
})

// ---------------------------------------------------------------- pricing per provider

test('costUsd accepts a provider rate and falls back to the Jev list price', () => {
  assert.equal(costUsd(1_000_000, 0.0294), 0.0294)
  assert.equal(costUsd(1_000_000, undefined), USD_PER_MTOK_INPUT)
  assert.equal(costUsd(1_000_000, 0), USD_PER_MTOK_INPUT, 'a zero rate is bogus, not free')
  assert.equal(costUsd(1_000_000, 'nonsense'), USD_PER_MTOK_INPUT)
})

test('a day mixing providers is priced per record, not per token total', () => {
  const ledger = new Ledger('')
  const now = ledger.now()
  ledger.append({ ok: true, inputTokens: 1_000_000, provider: 'typesafe' })
  ledger.append({ ok: true, inputTokens: 1_000_000, provider: 'laya-studio', usdPerMtok: 0.0294 })
  const s = ledger.summary(now)
  assert.equal(s.inputTokens, 2_000_000)
  assert.equal(s.costUsd.toFixed(4), (0.042 + 0.0294).toFixed(4))
  assert.equal(s.total.costUsd.toFixed(4), (0.042 + 0.0294).toFixed(4))
})
