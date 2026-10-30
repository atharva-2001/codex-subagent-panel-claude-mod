export type Run = {
  pid: number
  slug: string
  startedAt: number
  lastWriteAt: number | null
  sizeKb: number
  // latest assistant message in the rollout, else the latest tool call
  last: string | null
  tokens: number | null
  model: string
  effort: string
  tier: string
  sandbox: string
}

declare module 'claude-code' {
  interface PluginState {
    'codex-runs': { runs: Run[]; offset: number }
  }
}
