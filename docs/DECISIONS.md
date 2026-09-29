# What this plugin takes, and what it refuses — with the evidence

`dsh-jev` is deliberately small. Five other Jev plugins for DeepSeek Harness exist, three of them
in the public catalog, and between them they carry far more surface than this one. Those features
were measured here before deciding, and most of them did not survive.

This file records the decisions so the next person does not rebuild a rejected feature, and so a
disagreement has something concrete to argue with. Every number below is reproducible from
`docs/MEASUREMENTS.md` and the experiments it links.

Short version:

| Feature | Seen in | Decision |
|---|---|---|
| Typed `noul` / `choice` / `score` tool | all of them | **keep** — the one measured win |
| Per-user provider and key | this plugin only | **keep** |
| Judgment ledger + spend accounting | `HorusJiang/dsh-jev-tools` | **adopted** |
| Per-session call cap, fail-open | `HorusJiang/dsh-jev-tools` | **adopted** |
| "Rank, never threshold" | `HorusJiang/dsh-jev-tools` | **adopted as a documented rule** |
| Probability calibration from labelled data | `HorusJiang`, `lldois` | **documented, not built** |
| Query-aware pruning of tool output | `HorusJiang/dsh-jev-tools` | **refused — measured to do nothing** |
| Semantic skill discovery / gating | `lldois`, `HorusJiang` | **refused — measured worse than nothing** |
| Semantic tool routing | `lldois` (`jev_find_tools`) | **refused — sibling of a failed feature** |
| Pre-execution safety gate | `7starsseeker/dsh-jev-guard` | **out of scope — unmeasured, and the failure is asymmetric** |
| Auto pre-turn hook | `lldois` | **refused — pays latency on every turn for a refused feature** |

## Kept: the typed-question tool

The only use of Jev this project measured as a win, and the reason the plugin exists. On a real
26-item labelled set, against the status quo of calling a model or spawning a subagent:

| | accuracy | latency | cost |
|---|---|---|---|
| `google/gemini-2.5-flash` | 25/26 | 5,932 ms | $0.00395 |
| `xiaomi/mimo-v2.5` | 26/26 | 17,359 ms | $0.00100 |
| **Jev** (37 items, one call) | 25/26 | **456 ms** | **$0.00029** |
| median real subagent | — | 48 s | $0.035 |

13× faster and 13.6× cheaper than the model at identical accuracy; 105× and ~120× against a
subagent. Full method, including the cases measured and rejected, in `docs/MEASUREMENTS.md`.

## Adopted: judgment ledger, spend accounting, call caps

All three come from `HorusJiang/dsh-jev-tools`, and all three are supported by numbers rather than
by taste.

**Ledger and spend.** A Jev call is not free and its cost is invisible today. Measured on this
plugin's own traffic: **11,377 input tokens for one pruning decision**, and a single turn can
present 27 oversized results. Input is billed at $0.042 per million tokens and output is free, so
cumulative input tokens *is* the cost. Without a record there is no way to notice that a plugin has
become the expensive part of a session.

**Call caps, fail-open.** The same source measured the arithmetic that matters: uncapped, the worst
turn fired 27 judgments ≈ 8.1 s of added serial latency; capped at three, 0.9 s. This plugin's own
rate is known, so the cap is a bounded, visible cost rather than a surprise. Fail-open is
non-negotiable: a judgment is an optimisation, and it must never be the reason a task failed.

**Rank, never threshold.** Jev's raw numbers are a good ordering and a poor probability. Measured
here: accuracy by confidence band was **33% / 25% / 67% / 57%** — not monotonic, so not calibrated —
including two wrong answers at 0.85 and 0.96 confidence. Their independent replication reached the
same conclusion ("it saturates at 1.000 on easy inputs and runs systematically low on hard ones").
Any internal use of a probability must sort with it, not compare it against a fixed number.

## Documented, not built: calibration

A fitted mapping on the caller's own labelled data is the correct fix for the paragraph above, and
both Jev plugins that carry it do it properly — including binding the fit to the model version,
because `jev-latest` moves between releases and a mapping fitted on one version is meaningless on
the next.

It is not built here because it is only as good as the labels a user brings, and this plugin has no
way to hold them yet. `docs/MEASUREMENTS.md` states the honest position: quoting an accuracy figure
requires data you labelled yourself. When the ledger has enough history to make the question
concrete, the fit is one function away.

## Refused: query-aware pruning of tool output

The most interesting feature in the set, and the one with the clearest answer.

`HorusJiang/dsh-jev-tools` hooks `tools/post-execute`, chunks an oversized tool result, asks Jev
which chunks are relevant **to the current task**, and keeps the top-ranked ones inside a budget.
Its engineering is careful: deterministic head/tail floors, rank-not-threshold, pure fail-open, a
per-turn cap, a fingerprint cache. Its README is honest that the quality claim is unmeasured:

> It is why **no accuracy figure is quoted here**: the only quality evidence so far is 8/8 on eight
> self-authored Chinese three-way samples … **is not enough to state an accuracy**.

So it was measured. Method: 4,170 real tool results ≥8,192 chars extracted from 276 session
transcripts, each with the user request in flight at call time (the same three-message window the
plugin uses). Four arms on the same payload, and a control arm that had to answer every probe from
the **full** text before the case counted — it did, 100%, so a later failure is the pruner's fault
and not the reader's.

Population: 35 cases where a term the request names lies **only** in the region the deterministic
pruner (head 4096 + tail 1024) throws away.

| arm | retains the task-named term | keeps | payload |
|---|---|---|---|
| deterministic head+tail | 8.6% (all reader false positives) | 16% | 5,120 chars |
| **ranked, same budget** | **25.7%** | 14% | 4,453 chars |
| random, same budget | 20.0% | 14% | 4,450 chars |
| faithful model of `dsh-jev-tools` | 71.4% | **68%** | **17,843 chars** |

**Ranked against random, paired: 4 to 2, exact sign test p = 0.688.** No difference.

Three things follow, and they are why the feature is not here:

1. **Relevance is not what recovers the content.** Random selection at the same budget already goes
   from 0% to 20% simply by not discarding the middle. The selection criterion adds nothing
   measurable.
2. **The apparent win is budget, not judgement.** The faithful arm retains 71% because it keeps
   **68% of the original — 4.25× the context** of the deterministic pruner; `keepHigh 0.5` passes
   ~42% of segments unconditionally. Normalised per character kept, the ranked arm (~17%) and that
   arm (~18%) are level. Anyone can reproduce that by raising the deterministic budget and paying
   nothing.
3. **The domain bounds it.** In **68%** of oversized results, the request names nothing that appears
   in the region the deterministic pruner drops. There is no signal for a task-aware ranker to read.

Against that, the cost is one Jev call and **11,377 input tokens per pruned result** — to make a
choice a coin flip matches.

Note the earlier, smaller run (n=29) *did* separate ranked from random, 5 to 1. It did not survive
removing an artefact: that probe could also occur in the head, which handed the deterministic arm
free hits. The clean population is the one above. This is recorded because the wrong version is the
more flattering one, and it is the version that would have justified building the feature.

## Refused: semantic skill discovery and tool routing

`lldois/dsh-jev` ships `jev_find_skill` and `jev_find_tools`; `HorusJiang` suggests skills too. The
same idea, measured on 26 real (request → skill actually loaded) pairs and 200 real turns with no
skill loaded:

| | Jev | the agent alone | with a suggestion |
|---|---|---|---|
| wrong load | **54.2%** | 16.8% | 7.3% |
| needless load | **95.0%** | 9.8% | 4.0% |

Root cause, and the part worth keeping: the three gate questions the cookbook supplies have **no
discriminative power** on a coding workload — mean on positives vs negatives of −0.03, +0.03 and
−0.08. The failure is not Jev's; it is the rubric's. A question nobody can answer differently for
the two classes cannot gate anything.

`jev_find_tools` is the same shape with a smaller catalogue, so the same objection applies until
someone measures it. Measuring it is cheap and welcome — this file is not a substitute for that.

## Adopted: Laya Studio as a first-class provider

Laya is the open-weight (Apache-2.0) competitor to Jev: a ModernBERT-large encoder with an
option-marker head, served by an independent Swiss host over the **same `/v1/systemone` wire
protocol** ([wire-compatible](https://laya.studio/docs/jev-migration)). Adding it as a provider
row is a dozen lines, and it is what the provider abstraction in this plugin was always for.

What first-class support buys over pointing *Custom* at the URL:

- **Honest money.** The ledger now prices every record at its provider's rate
  ($0.0294 for Laya Studio, $0.042 for the Jev providers). Days that mix providers sum
  per record instead of applying one global rate — the whole point of spend accounting.
- **The bounds are applied, not documented.** Laya Studio answers 33 questions with a 400 and
  65 options with a 422. The tool refuses before the request leaves, naming the provider and
  the number.
- **The real caveats are visible where the choice is made.** Settings shows Laya's note and the
  auto-routing (its `model` is sent empty so its own router picks; an override can still pin
  `english` / `multilingual` / `typed-decisions`).

What was **not** adopted, deliberately:

- **No default switch.** Jev stays the default. Laya's published weaknesses — 512–1,024
  tokens of state per question (truncated silently), and a large-label cliff (Banking77 0.425
  vs Jev's 0.870) — hit exactly the workloads this tool exists for: judging long tool outputs
  and wide option lists. The 30% price saving on this plugin's own measured traffic (~11k
  input tokens per pruned judgment) is fractions of a cent; it is not a reason to trade
  context for it.
- **No per-provider confidence normalisation.** Laya computes `confidence` as
  1 − normalised entropy; Jev uses a max-probability formula. Rescaling one to imitate the
  other would invent a precision neither has. The plugin's rule — *rank, never threshold* —
  already holds across providers.
- **No `action.act_probability` surfacing.** Laya returns it, and its own tracker says it
  "carries no usable signal yet". Ignored until that changes.

Self-hosting needs no code at all: *Custom* + a Jev-compatible Laya server (the package ships
`laya-serve`; `ollaya` and 1Panel's `laya-server` implement the same wire). The weights are
~1.7 GB (421M English + 322M multilingual), which runs CPU-only on a modest VPS — that path
is a deployment choice, and the plugin just points at whatever speaks the contract.

## Out of scope: the pre-execution safety gate

`7starsseeker/dsh-jev-guard` mounts `tools/pre-execute` and puts one Jev question in front of every
shell call, with four outcomes including *revise* and *escalate*. It is a different product with a
different risk profile, and nothing here has measured it.

Two reasons it is not merged in. First, its own author states the design constraint better than this
file could: a gate that fails open *fails all the way to "approved"*, so every unclear path must
land on `escalate` — that is an inverted fail-open, the opposite of the one this plugin needs, and
the two rules should not live behind one setting. Second, a security verdict is a claim about
behaviour under adversarial input, and this project's method — real traffic, control arms,
hand-labelled ground truth — has not been applied to it. Shipping it unmeasured would contradict
everything else in this file.

## Refused: the automatic pre-turn hook

`lldois` runs a judgment on every incoming user turn to drive skill suggestion. It inherits the
rejection above, and it adds latency to every turn rather than to the turns that need it. This
plugin registers one tool the model calls when it decides to; nothing runs on its own.

## What this plugin deliberately does not do

- It does not generate text. Jev cannot, so summarising, titling and compaction are structurally out
  of reach.
- It does not gate anything by default. Every judgement is requested by the model, at a moment it
  chose.
- It does not hide a failure. A missing key, an unknown provider, a rejected credential and an
  exhausted cap each produce a message naming what to change.
