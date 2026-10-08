# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-10-08

### Fixed

- **A 429 with an absurd `Retry-After` no longer freezes the tool.** A free-tier
  provider has sent `retry-after: 15366` (over four hours); honouring it
  literally looked like a hang. A window over 30 s now fails immediately, naming
  the wait; a window within the budget is still honoured, capped at 30 s.
- **A cancelled call stops retrying at once.** Cancelling the turn now aborts the
  backoff sleep too, instead of sleeping and retrying for up to a further 52 s —
  and the error says "cancelled" rather than pretending it timed out.
- **The API key never reaches an error message.** Every string leaving
  `callJev` is redacted, so a provider or proxy echoing the request header can
  no longer land the key in the model's context, in `ledger.jsonl` or in a
  bridge response. The legacy `apiKey` settings field is also stripped from the
  `describe` payload sent to the browser.
- **A blank API key fails with a clear message.** `resolveApiKey` trims every
  candidate: a key pasted with a stray newline now works, and a whitespace-only
  value reads as "not configured" instead of going out as `Bearer    ` and
  surfacing an opaque 401.
- **`instructions` must be a non-empty string.** A blank, padded or non-string
  `instructions` used to pass validation and surface as a raw provider 400 (or
  as a paid call that judged nothing).
- **A question named `__proto__` is no longer dropped.** Validation wrote it
  through `Object.prototype`'s setter, silently losing the question; it now
  survives to the provider.

### Changed

- The README's configuration reference lists `opencode-zen` as a provider value,
  documents the `Retry-After` cap and the cancellation behaviour, and states the
  key-redaction guarantee.

### Added

- `CHANGELOG.md`.
- CI: pushing a `v*` tag publishes to npm with provenance (OIDC), running the
  test suite first.

## [0.2.1] - 2026-10-04

### Added

- OpenCode Zen as a provider: the paid `jev-1.13` checkpoint over Zen's
  TypeSafe-compatible `POST /v1/systemone` contract. Zen only honours the free
  checkpoint from inside the OpenCode client, so it is not usable from DSH.

## [0.2.0] - 2026-09-29

### Added

- Laya Studio as a first-class provider: its published bounds (32 questions per
  request, 64 options per question) are enforced before the request leaves, and
  the ledger prices its records at its own rate ($0.0294/MTok).

## [0.1.0] - 2026-09-21

### Added

- Initial release: the typed `jev` tool (`noul` / `choice` / `score`), per-user
  provider and API key in Settings, the judgment ledger with daily call/token
  caps, and the loopback-only settings bridge.
