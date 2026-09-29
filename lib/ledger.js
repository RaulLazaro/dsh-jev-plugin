/**
 * An append-only record of every judgment this plugin asked for, and the spend
 * derived from it.
 *
 * Why this exists: a Jev call is invisible and not free. Measured on this
 * plugin's own traffic, one pruning decision cost 11,377 input tokens, and a
 * single turn can present 27 oversized results — that is a real bill with no
 * line item anywhere. Input is billed per million tokens — $0.042 for Jev,
 * $0.0294 for Laya Studio — and output is free, so cumulative input tokens,
 * priced at the rate each request was actually made at, *is* the cost.
 *
 * The record is the tail of a JSONL file, kept in memory so a summary is free:
 * the file is read once at start-up and rewritten only when the in-memory copy
 * outgrows its cap, so the cost of the ledger itself stays bounded and
 * predictable.
 *
 * @module dsh-jev-plugin/ledger
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** TypeSafe's published price: $42 per billion input tokens, output free.
 * Records with no `usdPerMtok` — every line written before providers had their
 * own rate, and the Jev providers today — are priced at this rate. */
export const USD_PER_MTOK_INPUT = 0.042

/** Records held in memory; the file is trimmed to KEEP after it overflows. */
export const MAX_RECORDS = 5000
export const KEEP_RECORDS = 2500

/** Local-day key, so "today" matches the clock the user reads. */
export function dayKey (when) {
  const d = new Date(when)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Cost in USD for an input-token count. Output tokens are not billed.
 * `usdPerMtok` is the rate the request carried; absent or bogus values fall
 * back to the Jev list price, so an old ledger stays readable and a default
 * provider still prices at $0.042.
 */
export function costUsd (inputTokens, usdPerMtok) {
  const rate = Number(usdPerMtok) > 0 ? Number(usdPerMtok) : USD_PER_MTOK_INPUT
  return (Number(inputTokens) || 0) / 1e6 * rate
}

export class Ledger {
  /** @param {string} file absolute path of the JSONL file; '' disables persistence. */
  constructor (file, { now = () => Date.now() } = {}) {
    this.file = file
    this.now = now
    this.records = []
    // Resolve the directory ONCE. Measured here: a mkdirSync on a pathological
    // path can block rather than fail, and doing it per append would put that
    // on the hot path of every judgment. A directory that cannot be prepared
    // turns the ledger into a memory-only one for this run — a judgment must
    // never wait on its accountant.
    this.persistent = this.prepare()
    this.load()
  }

  /** Create the parent directory once; false means no persistence this run. */
  prepare () {
    if (!this.file) return false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      return true
    } catch {
      return false
    }
  }

  load () {
    if (!this.file) return
    let text
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    const out = []
    for (const line of text.split('\n')) {
      if (line === '') continue
      try {
        const rec = JSON.parse(line)
        if (rec !== null && typeof rec === 'object' && typeof rec.t === 'number') out.push(rec)
      } catch {
        // A torn last line from a crash must not take the ledger down.
      }
    }
    this.records = out.slice(-MAX_RECORDS)
  }

  /** Append one judgment. Never throws: a ledger failure must not fail a call. */
  append (record) {
    const rec = { t: this.now(), ...record }
    this.records.push(rec)
    if (this.records.length > MAX_RECORDS) this.records = this.records.slice(-KEEP_RECORDS)
    if (!this.persistent) return rec
    try {
      appendFileSync(this.file, `${JSON.stringify(rec)}\n`)
      if (this.records.length === KEEP_RECORDS) this.rewrite()
    } catch {
      // Best effort: the in-memory copy is still correct for this run.
    }
    return rec
  }

  rewrite () {
    if (!this.persistent) return
    try {
      const body = this.records.map((r) => JSON.stringify(r)).join('\n')
      writeFileSync(this.file, body === '' ? '' : `${body}\n`)
    } catch {
      // ignore
    }
  }

  /** Spend and volume for the local day containing `when`. */
  summary (when = this.now()) {
    const key = dayKey(when)
    const today = this.records.filter((r) => dayKey(r.t) === key)
    const inputTokens = today.reduce((s, r) => s + (Number(r.inputTokens) || 0), 0)
    const failures = today.filter((r) => r.ok === false).length
    const allInput = this.records.reduce((s, r) => s + (Number(r.inputTokens) || 0), 0)
    const costOf = (list) => list.reduce((s, r) => s + costUsd(r.inputTokens, r.usdPerMtok), 0)
    return {
      day: key,
      calls: today.length,
      failures,
      inputTokens,
      outputTokens: today.reduce((s, r) => s + (Number(r.outputTokens) || 0), 0),
      // Summed per record, not over the day's token total: a day that mixes
      // providers must not price Laya's tokens at Jev's rate.
      costUsd: costOf(today),
      total: { calls: this.records.length, inputTokens: allInput, costUsd: costOf(this.records) },
      last: this.records.length > 0 ? this.records[this.records.length - 1].t : null,
      file: this.file || null,
    }
  }

  /** Forget everything, in memory and on disk. */
  reset () {
    this.records = []
    if (this.file) this.rewrite()
  }
}
