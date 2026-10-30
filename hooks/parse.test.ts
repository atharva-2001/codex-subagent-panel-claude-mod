import { test, expect } from 'claude-code/testing'

import { ancestors, configDefaults, detailStyle, etimeMs, lastActivity, lastTokens, runFlags, tokens, ordered, parsePs, promptSnippet, runColor, twoLines } from './register'

test('parses codex exec rows, skips look-alikes, names runs', () => {
  const { parents, codex } = parsePs([
    '15058 14630  01:02:03 /x/vendor/aarch64-apple-darwin/bin/codex exec --skip-git-repo-check --output-last-message /r/logs/comp-pages.last.md do it',
    '14630     1     01:02:04 node /x/bin/codex exec --skip-git-repo-check',
    ' 6019  5952 01:55:22 npm exec @enescinar/twitter-mcp',
    '  777   700  2-00:00:01 /y/bin/codex exec --cd /w -c model_reasoning_effort=high --sandbox read-only Audit the pricing page copy for claims',
  ].join('\n'))
  expect(codex.map(r => [r.pid, r.slug, r.snippet])).toEqual([
    [15058, 'comp-pages', 'do it'],
    [777, undefined, 'Audit the pricing page copy for claims'],
  ])
  expect(ancestors(15058, parents)).toEqual([14630])
  expect(etimeMs('00:13')).toBe(13_000)
  expect(etimeMs('2-00:00:01')).toBe(172_801_000)
  expect(promptSnippet('--json -m gpt-5.6-luna a very long prompt that keeps going past forty characters')).toBe('a very long prompt that keeps going past…')
  expect(runColor(0)).toBe('claude')
  expect(runColor(11)).toBe('success')
})

test('last activity: newest assistant message, else newest tool call', () => {
  const row = (payload: object) => JSON.stringify({ type: 'response_item', payload })
  const msg = row({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First searches\nsurfaced  sources' }] })
  const call = row({ type: 'custom_tool_call', name: 'exec', input: 'const r =\n await x()' })
  expect(lastActivity(['{"cut mid-line', msg, call, '{"type":"event_msg"}'].join('\n'))).toBe('First searches surfaced sources')
  expect(lastActivity(['{"cut', call].join('\n'))).toBe('⚙ exec const r = await x()')
  expect(lastActivity('')).toBe(null)
})

test('order: stalled first, then newest first', () => {
  const now = 100 * 60_000
  const run = (pid: number, startedAt: number, lastWriteAt: number) => ({ pid, slug: String(pid), startedAt, lastWriteAt, sizeKb: 0, last: null, tokens: null, model: 'm', effort: 'e', tier: 't', sandbox: 's' })
  const list = [run(1, 10, now), run(2, 50, now), run(3, 5, now - 13 * 60_000)]
  expect(ordered(list, now).map(r => r.pid)).toEqual([3, 2, 1])
})

test('two lines: break at a space, ellipsis past the second', () => {
  expect(twoLines('short', 10)).toEqual(['short', ''])
  expect(twoLines('alpha beta gamma delta epsilon zeta', 12)).toEqual(['alpha beta', 'gamma delta…'])
})

test('flags from exec args, defaults from config, tokens from the log', () => {
  expect(runFlags(' -m gpt-6-luna --cd /w --sandbox workspace-write -c model_reasoning_effort=medium -c service_tier="flex" do it'))
    .toEqual({ model: 'gpt-6-luna', effort: 'medium', tier: 'flex', sandbox: 'workspace-write' })
  expect(runFlags(' --cd /w go')).toEqual({ model: undefined, effort: undefined, tier: undefined, sandbox: undefined })
  expect(configDefaults('model = "gpt-6-astra"   # note\nservice_tier = "default"\n[profiles.x]\nmodel = "other"\n'))
    .toEqual({ model: 'gpt-6-astra', effort: undefined, tier: 'default', sandbox: undefined })
  const tc = (n: number) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: n } } } })
  expect(lastTokens(['{"cut', tc(1000), tc(512_345)].join('\n'))).toBe(512_345)
  expect(tokens(512_345)).toBe('512k')
  expect(tokens(1_250_000)).toBe('1.3M')
})

test('details: rule breaks are filled chips', () => {
  expect(detailStyle('model', 'gpt-6-astra')).toHaveProperty('backgroundColor', 'error')
  expect(detailStyle('model', 'gpt-6-luna')).toEqual({ color: 'suggestion' })
  expect(detailStyle('tier', 'default')).toHaveProperty('backgroundColor', 'error')
  expect(detailStyle('tier', 'flex')).toEqual({ color: 'success' })
  expect(detailStyle('effort', 'xhigh')).toEqual({ color: 'error', bold: true })
})
