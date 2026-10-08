# dsh-jev-plugin

Ask [Jev](https://typesafe.ai), a System One decision model, typed questions from
DeepSeek Harness and get structured answers with probabilities.

Jev returns **judgements, not prose**: every question is evaluated in parallel
against the same block of text, so a request carrying 50 questions costs about
the same and takes about as long as one carrying 1. That makes it a good fit for
the judgements a coding agent has to repeat over many items — log lines, tool
outputs, failing tests, search results, candidate files, review comments —
without pulling them all into the model's context or spawning a subagent to read
them.

Measured against the two things the harness does today, on the same task and the
same data: **13x faster and 13.6x cheaper than a model at identical accuracy**, and
**105x faster and ~120x cheaper than a subagent** (median subagent: 9 requests,
48 s, $0.035). It *loses* to `grep` whenever the criterion is mechanical, so do
not use it for that. The full evidence — including the use cases that were
measured and then rejected — is in [`docs/MEASUREMENTS.md`](docs/MEASUREMENTS.md).
What this plugin deliberately refuses to do, and the measurement behind each
refusal, is in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## What it registers

| Surface | What it does |
| --- | --- |
| The `jev` tool | Sends `state` + `questions` and returns the typed answers, probabilities and confidence. |
| Settings → Plugins → **Jev** | Per-user provider choice, model override, custom endpoint, API key, and a **Test connection** button. |

## Install

The package carries its own bundle patch, so installing it is one command.
`dsh plugin` forwards to pnpm, so a local path, a git spec and a registry name
all work:

```bash
dsh plugin --profile web add /path/to/dsh-jev-plugin         # a local checkout
dsh plugin --profile web add github:RaulLazaro/dsh-jev-plugin  # straight from GitHub
dsh plugin --profile web add dsh-jev-plugin              # from the registry, once published
```

That adds the dependency, appends `dsh-jev-plugin` to the profile's bundle list, and
composes the row from [`cordis.patch.yml`](cordis.patch.yml). Confirm the
composition without booting anything:

```bash
dsh --profile web --dump-config | grep -A4 'dsh-jev-plugin'
# - id: jev
#   name: dsh-jev-plugin
#   config:
#     enabled: true
#     provider: typesafe
```

Then **restart the harness** to mount it — a running process does not pick up a
new bundle row. Nothing else is required: the API key is entered in the UI, not
in the composition.

To remove it again: `dsh plugin --profile web remove dsh-jev-plugin`.

## Configure

Open **Settings → Plugins → Jev**.

1. **Provider** — where Jev is served from (see below).
2. **Model override** — optional; empty means the provider's default.
3. **Base URL** — only for the *Custom* provider.
4. **API key** — stored in the DSH **credentials store**, never in
   `settings.yaml`. The field shows whether a key is already configured.
5. **Test connection** — performs one real round trip and reports the resolved
   provider, model, latency, input tokens and the answers.

### Providers

| Provider | Endpoint | Default model | Credential / env fallback |
| --- | --- | --- | --- |
| TypeSafe (direct) | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/typesafe/v1/systemone` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| Laya Studio | `https://api.laya.studio/v1/systemone` | *auto-routed* | `LAYA_API_KEY` |
| OpenCode Zen | `https://opencode.ai/zen/v1/systemone` | `jev-1.13` | `OPENCODE_ZEN_API_KEY` |
| Custom | your own URL | `jev-latest` | `JEV_API_KEY` |

Each provider has its own key, so switching provider switches which credential is
used. If you already exported the matching environment variable, no key needs to
be saved.

**Laya Studio** is a different model — [Laya](https://github.com/NandhaKishorM/laya),
an open-source (Apache-2.0) System One encoder — served by an independent host over the
same `/v1/systemone` wire. Same question types, same answer shape, ~30% lower input price
($0.0294 vs $0.042 per 1M tokens). The plugin applies its published bounds for you
(32 questions per request, 64 options per question) and prices the ledger at its own rate.
Know what you are trading: Laya reads only the first **512 tokens** (English) or **1,024**
(multilingual) of the state per question and truncates the rest silently — put the decisive
text first; it degrades on large label sets (published: 0.425 on Banking77 where Jev holds
0.870, so keep choices under ~20 options); and its `confidence` uses a different formula
(normalised entropy), so a threshold tuned against Jev does not carry over. Send `model`
empty (the default) and its router picks a checkpoint; pin `english`, `multilingual` or
`typed-decisions` only deliberately.

Every provider speaks the same contract, so **a self-hosted Laya works too**: point
*Custom* at your own server (e.g. `laya-serve`, `ollaya` or `laya-server`, all
Jev-compatible) at `http://127.0.0.1:<port>/v1/systemone` with any key. A 421M encoder fits
on a small CPU-only VPS — expect roughly a second per request on 2 vCPUs rather than the
32–40 ms a T4 GPU gives.

> **Evaluation is not served through the OpenAI- or Anthropic-compatible
> endpoints.** Both providers above expose a TypeSafe-compatible
> `POST …/v1/systemone`; a custom endpoint must implement the same contract.

## Using the tool

```jsonc
{
  "state": "### ITEM 1\nTypeError: x is undefined\n\n### ITEM 2\nAll 42 tests passed in 1.2s",
  "questions": {
    "item1_failed": { "type": "noul",   "instructions": "Does ITEM 1 report a failure?" },
    "item2_failed": { "type": "noul",   "instructions": "Does ITEM 2 report a failure?" },
    "worst": {
      "type": "choice",
      "instructions": "Which item is the failure?",
      "criteria": { "item1": "a code exception", "item2": "a passing run" }
    }
  }
}
```

| Question type | Answer |
| --- | --- |
| `noul` | `noul` — the probability of *yes*, 0–1 |
| `choice` | `choice`, `probabilities`, `confidence` |
| `score` | `score` (an ordered rubric, may fall between rungs), `probabilities`, `confidence` |

**Ask atomic questions.** Reference each item by a stable label (`### ITEM 7`)
and ask one question per item; a question about a whole document invites a guess.
Instructions and criteria are written in English; the state may be in any
language.

**Read the probabilities, not just the pick.** A flat distribution means it is
guessing; `confidence` between roughly 0.4 and 0.6 on a `noul` carries little
information. Measure `confidence` against your own workload before gating an
action on it — it is a statistic derived from the distribution, not a guarantee.

### When not to use it

- Writing, summarising, translating or reformatting text — it cannot generate.
- Exact string or arithmetic work — it is not a regex engine or a calculator.
- Anything needing extended multi-step reasoning — decompose into atomic
  questions and combine the answers in code instead.

## Configuration reference

The `jev` settings namespace accepts:

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Register the `jev` tool. |
| `provider` | `typesafe` | `typesafe`, `vercel-gateway`, `laya-studio`, `opencode-zen` or `custom`. |
| `model` | *(provider default)* | Model id override. |
| `baseUrl` | — | Required by the `custom` provider. |
| `timeoutMs` | `60000` | Per-attempt request deadline. |
| `maxStateChars` | `40000` | Rejects oversized `state` with a message naming the limit. |
| `maxQuestions` | `200` | Rejects oversized question maps — the provider's own limit wins when it is lower (Laya Studio: 32). |
| `dataDir` | `<DSH_HOME>/dsh-jev` | Where the judgment ledger lives. |
| `dailyCallLimit` | `500` | Judgments per local day; `0` disables the cap. |
| `dailyTokenLimit` | `5000000` | Input tokens per local day; `0` disables the cap. |

Provider, model and limit fields can also be set directly in
`~/.dsh/settings.yaml`; the API key cannot, by design.

## Spend, and the ledger behind it

A Jev call is not free and, without a record, it is invisible. Measured on real
traffic: **11,377 input tokens for a single judgment**, in a turn that can
present 27 oversized results. Input is billed at $0.042 per million tokens and
output is free, so cumulative input tokens *is* the cost.

Every call — including a failed one — is appended to a JSONL ledger under
`dataDir`, and the Settings card shows the running total for the local day:

```
Today · 42 judgments · 318,904 input tokens · $0.0134
```

Two caps read that ledger before each request. They exist because the failure
mode of a metered feature is not an error, it is a surprise:

- `dailyCallLimit` (default 500)
- `dailyTokenLimit` (default 5,000,000 input tokens)

Exceeding either refuses the call **before** anything is spent, with a message
naming the number reached and the setting to raise. A cap of `0` means no cap.
The ledger never blocks a judgment: if its directory cannot be prepared, it
degrades to memory-only for that run rather than failing the call.

Nothing here thresholds on a probability. Jev's numbers are measured to be
**uncalibrated** — accuracy by confidence band came out 33% / 25% / 67% / 57%,
including two wrong answers at 0.85 and 0.96 confidence — so they are safe to
sort by and not to compare against a fixed number. See
[`docs/DECISIONS.md`](docs/DECISIONS.md) for what that rules out.

## Operational notes

- **The upstream answers `429` under load** ("the upstream provider is currently
  experiencing high demand"). The plugin retries with a 1s → 25s backoff and
  honours `Retry-After` up to 30 s; a longer window (a free tier has asked for
  hours) fails immediately, naming the wait, instead of freezing the session for
  it. Cancelling the turn stops the retries — including the backoff sleep — at
  once. Expect occasional slow calls and do not treat a retry as a failure.
- A rejected credential (401/403) is reported with a pointer to
  Settings → Jev rather than a raw status code.
- **The API key never leaves the process**: it is stripped from error messages
  before they reach the model, the ledger or the bridge.
- The Settings bridge is same-origin and **loopback-only**.

## Verify it works

After the restart, in order:

1. **The card is there.** Settings → Plugins → **Jev** should appear with a
   `key set` / `no key` badge.
2. **The key round-trips.** Pick the provider, paste the key, **Save key**, then
   **Test connection**. You get the resolved provider, model, latency, input
   tokens and a couple of answers from a real request.
3. **The tool is registered.** Ask the session to call `jev` on something small,
   e.g.:

   ```jsonc
   {
     "state": "### ITEM 1\nTypeError: x is undefined\n\n### ITEM 2\nAll 42 tests passed",
     "questions": {
       "item1_failed": { "type": "noul", "instructions": "Does ITEM 1 report a failure?" },
       "worst": { "type": "choice", "instructions": "Which item failed?",
                  "criteria": { "item1": "an exception", "item2": "a passing run" } }
     }
   }
   ```

   Expected: `item1_failed: 0.9x (yes)`, `item2` near `0.0x`, and `worst: item1`.
4. **A misconfiguration fails usefully.** Switch to *Custom* with an empty base
   URL: the tool must answer with a message naming Settings → Jev, not a raw
   status code.
5. **The bridge stays closed.** `curl -X POST http://your-host:3080/api/dsh-jev-settings/describe`
   from another machine must answer `403 loopback requests only`.

## Development

```bash
npm test          # node --test
```

The suite covers endpoint resolution, question validation messages, answer
formatting, key precedence (including trimming a padded key) and the retry
policy — cancellation, the `Retry-After` cap and credential redaction — plus the
tool's own wiring: that it reads the credentials service through the lazy
accessor on every call rather than capturing it once at registration. `lib/index.js` imports nothing
but `@deepseek-ai/schemastery`, declared as a peer dependency along with
`@deepseek-ai/cordis` — the host supplies both.

## Licence

MIT.
