import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run } from '../types'

const runs = atom({ plugin: 'codex-runs', key: 'runs' } as const, [])
const offset = atom({ plugin: 'codex-runs', key: 'offset' } as const, 0)

const ROWS = 2 // runs shown at once; the arrows scroll the rest
const TAIL_BYTES = 256 * 1024

const POLL_MS = 15_000
// a theme color per run, fixed by pid: theme keys follow the person's light or dark theme ('error' kept for stalls)
const PALETTE = ['claude', 'success', 'permission', 'planMode', 'autoAccept', 'suggestion', 'merged', 'ide', 'warning', 'remember'] as const
export const runColor = (pid: number) => PALETTE[pid % PALETTE.length]!
const STALL_MS = 12 * 60_000 // no transcript write for 12 minutes counts as stalled

// ps etime: [[dd-]hh:]mm:ss
export const etimeMs = (etime: string) => {
  const [days, rest] = etime.includes('-') ? etime.split('-') : ['0', etime]
  const parts = rest.split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  const [h, m, s] = parts
  return (((Number(days) * 24 + h) * 60 + m) * 60 + s) * 1000
}

const BOOLEAN_FLAGS = new Set(['--skip-git-repo-check', '--json', '--full-auto', '--oss'])

// first words of the prompt: what is left of the exec args once flags and their values are dropped
export const promptSnippet = (args: string) => {
  const words: string[] = []
  const tokens = args.trim().split(/\s+/)
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].startsWith('-')) words.push(tokens[i])
    else if (!BOOLEAN_FLAGS.has(tokens[i]) && !tokens[i].includes('=')) i++
  }
  const text = words.join(' ')
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

export type Flags = { model?: string; effort?: string; tier?: string; sandbox?: string }

// what the exec args set; -c values may arrive quoted ("flex")
export const runFlags = (args: string): Flags => {
  const pick = (re: RegExp) => args.match(re)?.[1]
  return {
    model: pick(/(?:^|\s)(?:-m|--model)[\s=](\S+)/),
    effort: pick(/model_reasoning_effort=\\?"?([\w-]+)/),
    tier: pick(/service_tier=\\?"?([\w-]+)/),
    sandbox: pick(/(?:^|\s)(?:-s|--sandbox)[\s=](\S+)/),
  }
}

// the top-level keys of ~/.codex/config.toml: what a run that sets nothing gets
export const configDefaults = (toml: string): Flags => {
  const top = toml.split(/^\[/m)[0] ?? ''
  const pick = (key: string) => top.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1]
  return { model: pick('model'), effort: pick('model_reasoning_effort'), tier: pick('service_tier'), sandbox: pick('sandbox_mode') }
}

// total tokens of the newest token_count event in a rollout tail
export const lastTokens = (tail: string) => {
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('"token_count"')) continue
    try {
      const total = JSON.parse(line).payload?.info?.total_token_usage?.total_tokens
      if (typeof total === 'number') return total
    } catch {}
  }
  return null
}

export const tokens = (n: number | null) =>
  n === null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`

// the native codex binary, not the node shim or anything else with "exec" in it
export const parsePs = (stdout: string) => {
  const parents = new Map<number, number>()
  const codex = stdout.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
    if (!match) return []
    parents.set(Number(match[1]), Number(match[2]))
    const exec = match[4].match(/^\S*\/codex\s+exec\b(.*)$/)
    if (!exec) return []
    const report = exec[1].match(/--output-last-message\s+(\S+)/)?.[1]
    const slug = report?.split('/').pop()?.replace(/(\.last)?\.md$/, '')
    return [{ pid: Number(match[1]), etime: match[3], slug, snippet: promptSnippet(exec[1]), flags: runFlags(exec[1]) }]
  })
  return { parents, codex }
}

export const ancestors = (pid: number, parents: Map<number, number>) => {
  const chain: number[] = []
  for (let p = parents.get(pid); p !== undefined && p > 1 && chain.length < 12; p = parents.get(p)) chain.push(p)
  return chain
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// newest assistant message in a rollout tail, else its newest tool call
export const lastActivity = (tail: string) => {
  let tool: string | null = null
  const lines = tail.split('\n')
  for (const line of lines.reverse()) {
    if (!line.includes('"response_item"')) continue
    let p
    try { p = JSON.parse(line).payload } catch { continue } // the first line of a tail is cut
    if (p?.type === 'message' && p.role === 'assistant') {
      const text = oneLine((p.content ?? []).map((c: { text?: string }) => c.text ?? '').join(' '))
      if (text) return text
    }
    if (!tool && (p?.type === 'custom_tool_call' || p?.type === 'function_call')) tool = `⚙ ${p.name} ${oneLine(String(p.input ?? p.arguments ?? ''))}`
  }
  return tool
}

// stalled first, then newest first
export const ordered = (list: Run[], now: number) =>
  [...list].sort((a, b) =>
    Number(stalledAt(b, now)) - Number(stalledAt(a, now)) || b.startedAt - a.startedAt || a.pid - b.pid)

const stalledAt = (r: Run, now: number) => r.lastWriteAt !== null && now - r.lastWriteAt > STALL_MS

// two lines of at most `cols`, broken at a space; the second ends in … when the text runs on
export const twoLines = (text: string, cols: number): [string, string] => {
  if (text.length <= cols) return [text, '']
  const cut = text.lastIndexOf(' ', cols) > cols / 2 ? text.lastIndexOf(' ', cols) : cols
  const rest = text.slice(cut).trim()
  return [text.slice(0, cut), rest.length > cols ? `${rest.slice(0, cols - 1)}…` : rest]
}

// the arrows stay with the prompt's history: the wheel over the band, or j/k with the band focused, move one run
const scrollBy = async ($: EngineInterface, by: number) => {
  const count = (await read($, runs)).length
  await update($, offset, from => Math.max(0, Math.min(count - ROWS, Math.min(from, count - ROWS) + by)))
}

// detail colors from the theme; what breaks a rule (astra, a non-flex tier, full access) is drawn as a filled chip
const ALARM = { color: 'inverseText', backgroundColor: 'error', bold: true } as const
export const detailStyle = (kind: 'model' | 'effort' | 'tier' | 'sandbox', value: string) => {
  if (kind === 'model') return value.includes('astra') ? ALARM : { color: 'suggestion' }
  if (kind === 'tier') return value === 'flex' ? { color: 'success' } : ALARM
  if (kind === 'sandbox') return value.includes('danger') ? ALARM : value === 'read-only' ? { color: 'success' } : { color: 'inactive' }
  return /^(xhigh|max)$/.test(value) ? { color: 'error', bold: true } : value === 'high' ? { color: 'warning' } : { color: 'inactive' }
}

export const ago = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    const [home, claudePid] = (await $.process.run(['sh', '-c', 'echo "$HOME $PPID"'])).stdout.trim().split(' ')
    const ownersDir = `${home}/.codex/run-owners`
    const defaults = configDefaults(await $.fs.read(`${home}/.codex/config.toml`).catch(() => ''))

    const poll = async () => {
      const now = await $.clock.now()
      // read every poll: /clear and in-app resume switch the session id without a new session.start
      const sessionId = await $.session.id()
      const ps = await $.process.run(['ps', '-axo', 'pid=,ppid=,etime=,command='])
      const { parents, codex } = parsePs(ps.stdout)
      const owners = new Map((await $.fs.list(ownersDir).catch(() => [])).map(f => [Number(f.name), f.mtimeMs]))

      // mine: started under this claude process, or recorded for this session by the dispatcher
      const found = (await Promise.all(codex.map(async r => {
        const startedAt = now - etimeMs(r.etime)
        for (const pid of [r.pid, ...ancestors(r.pid, parents)]) {
          if (String(pid) === claudePid) return { ...r, startedAt, name: undefined }
          const written = owners.get(pid)
          // pids get reused: only an owner file written around this run's start counts
          if (written === undefined || Math.abs(written - startedAt) > 60_000) continue
          const [owner, name] = (await $.fs.read(`${ownersDir}/${pid}`)).trim().split('\t')
          return owner === sessionId ? { ...r, startedAt, name } : undefined
        }
        return undefined
      }))).filter(r => r !== undefined)

      const rollouts = new Map<number, string>()
      if (found.length) {
        const lsof = await $.process.run(['lsof', '-a', '-p', found.map(r => r.pid).join(','), '-Fpn'])
        let pid = 0
        for (const line of lsof.stdout.split('\n')) {
          if (line.startsWith('p')) pid = Number(line.slice(1))
          else if (line.includes('/.codex/sessions/') && line.endsWith('.jsonl')) rollouts.set(pid, line.slice(1))
        }
      }
      const current: Run[] = await Promise.all(found.map(async r => {
        const path = rollouts.get(r.pid)
        const stat = path ? await $.fs.stat(path).catch(() => undefined) : undefined
        const tail = path ? await $.process.run(['tail', '-c', String(TAIL_BYTES), path]).catch(() => undefined) : undefined
        return {
          pid: r.pid,
          slug: r.name || r.slug || r.snippet || String(r.pid),
          startedAt: r.startedAt,
          lastWriteAt: stat?.mtimeMs ?? null,
          sizeKb: Math.round((stat?.size ?? 0) / 1024),
          last: tail ? lastActivity(tail.stdout) : null,
          tokens: tail ? lastTokens(tail.stdout) : null,
          model: r.flags.model ?? defaults.model ?? '?',
          effort: r.flags.effort ?? defaults.effort ?? '?',
          tier: r.flags.tier ?? defaults.tier ?? 'default',
          sandbox: r.flags.sandbox ?? defaults.sandbox ?? '?',
        }
      }))

      const before = await read($, runs)
      const live = new Set(current.map(r => r.pid))
      for (const r of before.filter(r => !live.has(r.pid))) $.ui.toast(`codex ${r.slug} finished`)
      const stalled = (r: Run) => stalledAt(r, now)
      const wasStalled = new Set(before.filter(stalled).map(r => r.pid))
      for (const r of current.filter(r => stalled(r) && !wasStalled.has(r.pid))) $.ui.toast(`codex ${r.slug} stalled (no write for 12m)`)
      await update($, runs, () => current)
    }

    await poll()
    $.clock.every(POLL_MS, poll)
    return started
  })

  // the arrows stay with the prompt's history: the wheel over the band, or j/k with the band focused, move one run
  on('ui.scroll', { component: 'AbovePrompt' }, async ($, e) => {
    await scrollBy($, Math.sign(e.by))
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const all = await read($, runs)
    if (e.props.hasSurvey || all.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()
    // runs a previous version stored lack the newer fields until the next poll
    const list = ordered(all.map(r => ({ last: null, tokens: null, model: '?', effort: '?', tier: '?', sandbox: '?', ...r })), now)
    const from = Math.min(await read($, offset), Math.max(0, list.length - ROWS))
    const shown = list.slice(from, from + ROWS)
    const stalledCount = list.filter(r => stalledAt(r, now)).length
    const scrolls = list.length > ROWS
    const cols = Math.max(20, e.props.bodyColumns - 4)

    // three lines per run: name in its theme color (fixed by pid, error color when stalled) with age·quiet·size, then what it last said
    const width = Math.max(...list.map(r => r.slug.length)) // all runs, so scrolling keeps the columns put
    return (
      <Box flexDirection="column">
        <Text dimColor>
          codex · {list.length} running{stalledCount ? ` · ${stalledCount} stalled` : ''}{scrolls ? ' · ctrl+x tab then j/k' : ''}
        </Text>
        {scrolls && <Button key="up" hotkey="k" plain dimColor onPress={() => scrollBy($, -1)} label={from ? `↑ ${from} more` : '↑'} />}
        {shown.map(r => {
          const quiet = r.lastWriteAt === null ? null : now - r.lastWriteAt
          const isStalled = stalledAt(r, now)
          return (
            <Box key={String(r.pid)} flexDirection="column" marginTop={1}>
              <Button key={String(r.pid)} plain onPress={() => $.ui.toast(`${r.slug}: ${r.last ?? 'no activity yet'}`)}>
                <Text color="inverseText" backgroundColor={isStalled ? 'error' : runColor(r.pid)} bold>
                  {' '}{isStalled ? '✗' : '●'} {r.slug.padEnd(width)}{' '}
                </Text>
                <Text dimColor>
                  {'  '}{ago(now - r.startedAt).padStart(3)} · {(quiet === null ? '?' : ago(quiet)).padStart(3)} quiet · {tokens(r.tokens).padStart(5)} tok
                </Text>
                <Text>{'  '}</Text>
                <Text {...detailStyle('model', r.model)}>{r.model}</Text>
                <Text dimColor> · </Text>
                <Text {...detailStyle('effort', r.effort)}>{r.effort}</Text>
                <Text dimColor> · </Text>
                <Text {...detailStyle('tier', r.tier)}>{r.tier}</Text>
                <Text dimColor> · </Text>
                <Text {...detailStyle('sandbox', r.sandbox)}>{r.sandbox}</Text>
                {isStalled && <Text {...ALARM}> STALLED </Text>}
              </Button>
              {twoLines(r.last ?? '…', cols).filter(Boolean).map((line, i) => (
                <Text key={String(i)} dimColor wrap="truncate-end">{'  '}{line}</Text>
              ))}
            </Box>
          )
        })}
        {scrolls && (
          <Button key="down" hotkey="j" plain dimColor onPress={() => scrollBy($, 1)} label={list.length - from - ROWS ? `↓ ${list.length - from - ROWS} more` : '↓'} />
        )}
      </Box>
    )
  })
}
