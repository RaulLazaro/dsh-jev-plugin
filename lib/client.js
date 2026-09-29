/**
 * dsh-jev-plugin — browser half.
 *
 * Registers one card in Settings → Plugins (`settings.plugin.item`) that lets
 * each user pick the provider, point at a custom endpoint, and store their own
 * API key in the DSH credentials service.
 *
 * Written as plain React.createElement (no JSX) in the __ModuleLoader__ bundle
 * format this deployment loads plugin clients with.
 *
 * ON THE ID BELOW. It must equal the package name exactly. The client-modules
 * boot config is keyed by package name —
 * `{"id":"dsh-jev-plugin","url":"/plugins/??dsh-jev-plugin/client.js","inject":[…]}` —
 * and the loader looks this module up by that key. It registered as `dsh-jev`
 * while the package was `dsh-jev-plugin`, so the lookup missed and the client
 * half died with `failed to import loader entry`.
 *
 * It is a literal rather than a shared constant on purpose: DSH concatenates
 * every plugin's client half into ONE script
 * (`/plugins/??a/client.js,b/client.js,…`), so a top-level declaration here would
 * share a scope with ~40 other plugins and a name collision would take the whole
 * bundle down, not just this card. `test/client-bundle.test.mjs` asserts the id
 * matches package.json instead, so a future rename fails the suite rather than
 * the browser.
 */
window.__ModuleLoader__.load({
  id: 'dsh-jev-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const BRIDGE = '/api/dsh-jev-settings'
    const NS = 'jev'
    // Scoped inside the factory, so it cannot collide with the other plugins
    // concatenated into the same script. Must stay in step with the loader id
    // above; `test/client-bundle.test.mjs` checks both against package.json.
    const PACKAGE = 'dsh-jev-plugin'

    const css = `
.dshjev-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;min-width:0;list-style:none;overflow:hidden;margin-bottom:8px}
.dshjev-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dshjev-header{width:100%;color:inherit;cursor:pointer;text-align:left;font:inherit;background:0 0;border:0;align-items:center;gap:8px;padding:10px 14px;display:flex}
.dshjev-header:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshjev-headText{flex-direction:column;flex:1;gap:2px;min-width:0;display:flex;overflow:hidden}
.dshjev-name{color:var(--dsw-alias-label-primary);white-space:nowrap;text-overflow:ellipsis;font-weight:600;overflow:hidden}
.dshjev-description{color:var(--dsw-alias-label-tertiary);white-space:nowrap;text-overflow:ellipsis;font-size:12px;overflow:hidden}
.dshjev-badge{flex:none;font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.dshjev-badgeOk{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dshjev-badgeWarn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dshjev-chevron{color:var(--dsw-alias-label-tertiary);flex:none;font-size:13px;transition:transform .12s}
.dshjev-chevronOpen{transform:rotate(180deg)}
.dshjev-body{flex-direction:column;gap:14px;padding:0 14px 14px;display:flex}
.dshjev-field{flex-direction:column;gap:4px;min-width:0;display:flex}
.dshjev-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
.dshjev-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.dshjev-input,.dshjev-select{border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-specific-input-major);border-radius:6px;padding:6px 8px;font-size:13px;width:100%}
.dshjev-select{color-scheme:light dark}
.dshjev-select option{background-color:#fff;color:#1f2328}
@media (prefers-color-scheme:dark){.dshjev-select{color-scheme:dark}.dshjev-select option{background-color:#1e1f24;color:#e8e8ea}}
.dshjev-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshjev-btn{cursor:pointer;font:inherit;font-size:13px;border-radius:6px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dshjev-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dshjev-btn:disabled{opacity:.5;cursor:default}
.dshjev-primary{border-color:var(--dsw-alias-label-dimmed);font-weight:600}
.dshjev-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.6;white-space:pre-wrap}
.dshjev-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6;white-space:pre-wrap}
.dshjev-usage{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshjev-usage .dshjev-btn{font-size:11px;padding:2px 8px}
`

    function adoptStyles() {
      const ID = 'dsh-jev-styles'
      if (document.getElementById(ID) !== null) return
      const style = document.createElement('style')
      style.id = ID
      style.textContent = css
      document.head.appendChild(style)
    }

    async function post(route, body) {
      const response = await fetch(`${BRIDGE}/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      return response.json()
    }

    function Field(props) {
      return h(
        'label',
        { className: 'dshjev-field' },
        h('span', { className: 'dshjev-label' }, props.label),
        props.children,
        props.hint ? h('span', { className: 'dshjev-hint' }, props.hint) : null,
      )
    }

    function JevCard() {
      const [open, setOpen] = React.useState(false)
      const [view, setView] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [key, setKey] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [test, setTest] = React.useState(null)

      const load = React.useCallback(async () => {
        try {
          const result = await post('describe')
          if (result?.ok) {
            setView(result.value)
            setDraft({
              enabled: result.value.value.enabled !== false,
              provider: result.value.value.provider ?? 'typesafe',
              model: result.value.value.model ?? '',
              baseUrl: result.value.value.baseUrl ?? '',
            })
          } else {
            setNote({ bad: true, text: result?.message ?? 'could not read the settings' })
          }
        } catch (error) {
          setNote({ bad: true, text: String(error?.message ?? error) })
        }
      }, [])

      const resetUsage = async () => {
        setBusy(true)
        try {
          const result = await post('usage', { reset: true })
          // Only the usage figure changes: reloading the whole view would throw
          // away an edit the user has not saved yet.
          if (result?.ok) setView((v) => ({ ...v, usage: result.value }))
          else setNote({ bad: true, text: result?.message ?? 'could not reset the ledger' })
        } catch (error) {
          setNote({ bad: true, text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      React.useEffect(() => {
        if (open && view === null) void load()
      }, [open, view, load])

      const providers = view?.providers ?? []
      const provider = providers.find((p) => p.id === draft?.provider) ?? providers[0]
      const dirty =
        draft !== null &&
        view !== null &&
        (draft.enabled !== (view.value.enabled !== false) ||
          draft.provider !== (view.value.provider ?? 'typesafe') ||
          draft.model !== (view.value.model ?? '') ||
          draft.baseUrl !== (view.value.baseUrl ?? ''))

      const run = async (fn) => {
        setBusy(true)
        setNote(null)
        try {
          await fn()
        } catch (error) {
          setNote({ bad: true, text: String(error?.message ?? error) })
        } finally {
          setBusy(false)
        }
      }

      const save = () =>
        run(async () => {
          const result = await post('mutate', {
            expectedRevision: view?.revision,
            ops: [
              { op: 'set', path: ['enabled'], value: draft.enabled },
              { op: 'set', path: ['provider'], value: draft.provider },
              { op: 'set', path: ['model'], value: draft.model },
              { op: 'set', path: ['baseUrl'], value: draft.baseUrl },
            ],
          })
          if (!result?.ok) {
            setNote({ bad: true, text: result?.message ?? 'the settings were rejected' })
            return
          }
          setView(result.value)
          setNote({ text: 'Saved.' })
        })

      const saveKey = () =>
        run(async () => {
          const result = await post('key-set', { value: key })
          if (!result?.ok) {
            setNote({ bad: true, text: result?.message ?? 'the key was rejected' })
            return
          }
          setKey('')
          setView(result.value)
          setNote({ text: `Key saved for ${result.value.credential}.` })
        })

      const clearKey = () =>
        run(async () => {
          const result = await post('key-unset')
          if (!result?.ok) {
            setNote({ bad: true, text: result?.message ?? 'the key could not be removed' })
            return
          }
          setView(result.value)
          setNote({ text: 'Key removed.' })
        })

      const runTest = () =>
        run(async () => {
          setTest(null)
          const result = await post('test')
          setTest(result)
        })

      const status = () => {
        if (view === null) return h('span', { className: 'dshjev-badge' }, '…')
        if (view.keyConfigured) return h('span', { className: 'dshjev-badge dshjev-badgeOk' }, 'key set')
        if (view.envFallback) return h('span', { className: 'dshjev-badge dshjev-badgeOk' }, 'env var')
        return h('span', { className: 'dshjev-badge dshjev-badgeWarn' }, 'no key')
      }

      return h(
        'li',
        { className: open ? 'dshjev-card dshjev-cardOpen' : 'dshjev-card' },
        h(
          'button',
          {
            className: 'dshjev-header',
            type: 'button',
            onClick: () => setOpen(!open),
            'aria-expanded': open,
          },
          h(
            'span',
            { className: 'dshjev-headText' },
            h('span', { className: 'dshjev-name' }, 'Jev'),
            h(
              'span',
              { className: 'dshjev-description' },
              'Typed decisions (noul / choice / score) with probabilities, for judging many items in one call.',
            ),
          ),
          status(),
          h('span', { className: open ? 'dshjev-chevron dshjev-chevronOpen' : 'dshjev-chevron' }, '▾'),
        ),
        open
          ? h(
              'div',
              { className: 'dshjev-body' },
              h(
                Field,
                { label: 'Provider', hint: 'Decides the endpoint and the model. Each provider has its own API key.' },
                h(
                  'select',
                  {
                    className: 'dshjev-select',
                    value: draft?.provider ?? 'typesafe',
                    disabled: busy || draft === null,
                    onChange: (event) => setDraft({ ...draft, provider: event.target.value }),
                  },
                  providers.map((p) => h('option', { key: p.id, value: p.id }, p.label)),
                ),
              ),
              provider && provider.url
                ? h(
                    'span',
                    { className: 'dshjev-hint' },
                    `Endpoint: ${provider.url} · `
                    + (provider.modelHint ?? `default model ${provider.model}`),
                  )
                : null,
              provider && provider.note
                ? h('span', { className: 'dshjev-hint' }, provider.note)
                : null,
              draft?.provider === 'custom'
                ? h(
                    Field,
                    {
                      label: 'Base URL',
                      hint: 'Any endpoint implementing the TypeSafe contract, POST /v1/systemone.',
                    },
                    h('input', {
                      className: 'dshjev-input',
                      value: draft.baseUrl,
                      disabled: busy,
                      placeholder: 'https://example.com/v1/systemone',
                      onChange: (event) => setDraft({ ...draft, baseUrl: event.target.value }),
                    }),
                  )
                : null,
              h(
                Field,
                {
                  label: 'Model override',
                  hint: 'Leave empty to use the provider default shown above.',
                },
                h('input', {
                  className: 'dshjev-input',
                  value: draft?.model ?? '',
                  disabled: busy || draft === null,
                  placeholder: provider?.modelHint ? 'english | multilingual | typed-decisions' : (provider?.model ?? ''),
                  onChange: (event) => setDraft({ ...draft, model: event.target.value }),
                }),
              ),
              h(
                Field,
                {
                  label: `API key for ${view?.credential ?? 'the selected provider'}`,
                  hint: provider?.keyHint
                    ? `${provider.keyHint}. Stored in the DSH credentials store, never in settings.yaml.`
                    : 'Stored in the DSH credentials store.',
                },
                h(
                  'span',
                  { className: 'dshjev-row' },
                  h('input', {
                    className: 'dshjev-input',
                    style: { flex: '1 1 220px' },
                    type: 'password',
                    value: key,
                    disabled: busy,
                    autoComplete: 'off',
                    placeholder: view?.keyConfigured ? '•••• (configured — type to replace)' : 'paste the key',
                    onChange: (event) => setKey(event.target.value),
                  }),
                  h(
                    'button',
                    {
                      className: 'dshjev-btn',
                      type: 'button',
                      disabled: busy || key.trim().length === 0,
                      onClick: saveKey,
                    },
                    'Save key',
                  ),
                  h(
                    'button',
                    {
                      className: 'dshjev-btn',
                      type: 'button',
                      disabled: busy || !view?.keyConfigured,
                      onClick: clearKey,
                    },
                    'Remove',
                  ),
                ),
              ),
              h(
                'label',
                { className: 'dshjev-row' },
                h('input', {
                  type: 'checkbox',
                  checked: draft?.enabled !== false,
                  disabled: busy || draft === null,
                  onChange: (event) => setDraft({ ...draft, enabled: event.target.checked }),
                }),
                h('span', { className: 'dshjev-label' }, 'Enable the jev tool'),
              ),
              view?.endpointError
                ? h('span', { className: 'dshjev-err' }, view.endpointError)
                : null,
              note
                ? h('span', { className: note.bad ? 'dshjev-err' : 'dshjev-ok' }, note.text)
                : null,
              test
                ? h(
                    'span',
                    { className: test.ok ? 'dshjev-ok' : 'dshjev-err' },
                    test.ok
                      ? `OK · ${test.value.provider} · ${test.value.model} · ${test.value.latencyMs} ms · ${test.value.inputTokens} input tokens\n${JSON.stringify(test.value.answers)}`
                      : `Failed: ${test.message}`,
                  )
                : null,
              view?.usage
                ? h(
                    'span',
                    { className: 'dshjev-usage' },
                    `Today · ${view.usage.calls} judgment${view.usage.calls === 1 ? '' : 's'}`
                      + ` · ${Number(view.usage.inputTokens).toLocaleString()} input tokens`
                      + ` · $${Number(view.usage.costUsd).toFixed(4)}`
                      + (view.usage.failures > 0 ? ` · ${view.usage.failures} failed` : ''),
                    h(
                      'button',
                      { className: 'dshjev-btn', type: 'button', disabled: busy, onClick: resetUsage },
                      'Reset',
                    ),
                  )
                : null,
              h(
                'span',
                { className: 'dshjev-row' },
                h(
                  'button',
                  {
                    className: 'dshjev-btn dshjev-primary',
                    type: 'button',
                    disabled: busy || !dirty,
                    onClick: save,
                  },
                  busy ? 'Working…' : 'Save',
                ),
                h(
                  'button',
                  {
                    className: 'dshjev-btn',
                    type: 'button',
                    disabled: busy || !dirty || view === null,
                    onClick: () =>
                      setDraft({
                        enabled: view.value.enabled !== false,
                        provider: view.value.provider ?? 'typesafe',
                        model: view.value.model ?? '',
                        baseUrl: view.value.baseUrl ?? '',
                      }),
                  },
                  'Discard',
                ),
                h(
                  'button',
                  { className: 'dshjev-btn', type: 'button', disabled: busy, onClick: runTest },
                  'Test connection',
                ),
                h(
                  'button',
                  { className: 'dshjev-btn', type: 'button', disabled: busy, onClick: () => void load() },
                  'Reload',
                ),
              ),
            )
          : null,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      adoptStyles()
      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register(
          {
            name: 'settings.plugin.item',
            key: NS,
            id: PACKAGE,
            order: 130,
            inject: () => ({}),
          },
          JevCard,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
