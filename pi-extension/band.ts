// The band's task ledger for Oh My Pi (omp, and Tern, which runs omp): the same CSV rows and
// board.html the Claude Code band writes, from omp's extension events and session manager.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { boardHtml, tasksFrom } from '../hooks/band/board'
import type { Band, Tests } from '../hooks/band/types'
import {
  GREP_DEFS,
  addedLines,
  callsIn,
  defsIn,
  hits,
  inProject,
  isCode,
  isSource,
  isTestCommand,
  parseDefs,
  resume,
  snapshot,
  type Snapshot,
  taskKey,
  testCounts,
  upsertCsv,
  webhookRequest,
} from '../hooks/band/metrics'
import ponytailConfig from '../hooks/ponytail-config.js'
import { readDefaultMode, resolveSessionMode } from './index.js'

type Entry = { type: string; message?: { role?: string; model?: string; content?: unknown } }
type Ctx = {
  cwd: string
  mode?: string
  ui?: { notify?(message: string, type?: string): void; setStatus?(key: string, text: string | undefined): void }
  sessionManager: {
    getSessionId(): string
    getSessionFile(): string | undefined
    getHeader(): { timestamp: string; parentSession?: string } | null
    getEntries(): Entry[]
    getBranch(): Entry[]
    getUsageStatistics(): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
  }
}
// The fields of omp's tool_call / tool_result / agent_* events this extension reads.
type Event = { toolName?: string; toolCallId: string; input?: Record<string, unknown>; content?: unknown; isError?: boolean }
type Pi = {
  on(event: string, handler: (event: Event, ctx: Ctx) => unknown): void
  exec(command: string, args: string[], options?: { cwd?: string }): Promise<{ stdout: string; code: number }>
  getSessionName(): string | undefined
  registerCommand(name: string, options: { description: string; getArgumentCompletions?(prefix: string): { value: string; label: string }[] | null; handler(args: string, ctx: Ctx): unknown }): void
}

// What only the extension sees: one per task, shared with the task's subagents.
type Task = {
  root: string
  project: string
  known: Promise<Map<string, string>>
  reused: string[]
  created: string[]
  removed: string[]
  openCallers: string[]
  tests: Tests
  busyMs: number
  name: string
}

// Subagents run in-process with their own session; keyed by session file so a child finds its parent's task.
const tasks = new Map<string, Task>()

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])]
const text = (content: unknown) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map(c => (c?.type === 'text' ? c.text : '')).join('\n') : ''
// omp titles may lead with a nerd-font icon (private use area) a browser cannot draw.
const clean = (s: string) => s.replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '').trim().slice(0, 60)

export const ledgerDir = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ponytail', 'band')
const ledgerFile = (dir: string, project: string) => join(dir, `${project.replace(/[^\w.-]/g, '_')}.csv`)
const readText = (file: string) => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

// Builds board.html from every project's ledger.
function writeBoard(dir: string) {
  mkdirSync(dir, { recursive: true })
  const csvs = readdirSync(dir).filter(f => f.endsWith('.csv')).map(f => readText(join(dir, f)))
  const file = join(dir, 'board.html')
  writeFileSync(file, boardHtml(csvs.flatMap(tasksFrom), Date.now()))
  return file
}

const readConfig = (): Record<string, unknown> => {
  try {
    const config = JSON.parse(readText(ponytailConfig.getConfigPath()).replace(/^\uFEFF/, ''))
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {}
  } catch {
    return {}
  }
}

export type BandConfig = { ledger: boolean; webhookUrl: string; sendNames: boolean; webhookToken: string }

// The band's settings, the "band" object in ponytail's config.json, the same switches as the Claude Code plugin's.
// The webhook token comes only from PONYTAIL_WEBHOOK_TOKEN, never from a file that could land in a repo or a backup.
export function bandConfig(): BandConfig {
  const raw = readConfig().band
  const band: Record<string, unknown> = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    ledger: band.ledger !== false,
    webhookUrl: typeof band.webhookUrl === 'string' ? band.webhookUrl.trim() : '',
    sendNames: band.sendNames !== false,
    webhookToken: (process.env.PONYTAIL_WEBHOOK_TOKEN ?? '').trim(),
  }
}

// Keeps every other key of config.json, as writeDefaultMode does.
export function writeLedger(on: boolean) {
  const config = readConfig()
  const band = config.band && typeof config.band === 'object' ? config.band : {}
  config.band = { ...band, ledger: on }
  const file = ponytailConfig.getConfigPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2), 'utf8')
}

// The same row the ledger gets, to the webhook if one is set. Not awaited in the TUI: a slow endpoint must never hold
// up the turn. `omp -p` exits right after the run, so there it is awaited, at most 5 seconds.
async function send(row: Snapshot, ctx: Ctx, config: BandConfig) {
  if (config.webhookUrl === '') return
  const status = (text: string | undefined) => ctx.ui?.setStatus?.('ponytail-band', text)
  const request = webhookRequest(config.webhookUrl, config.webhookToken, config.sendNames, row)
  if ('refused' in request) return status(`ponytail band: ${request.refused}`)
  const sent = fetch(request.url, { ...request.init, signal: AbortSignal.timeout(5000) })
    .then(r => status(r.ok ? undefined : `ponytail band: webhook answered ${r.status}`))
    .catch(() => status('ponytail band: webhook unreachable'))
  if (ctx.mode === 'print' || ctx.mode === 'json') await sent
}

// Files an edit or write call touches: `path` (write, replace-mode edit) or hashline `[PATH#TAG]` headers.
// shortcut: ast_edit and other multi-file tools are not tracked; add their path fields if their edits matter.
export function editPaths(input: Record<string, unknown>, cwd: string): string[] {
  const paths = typeof input.path === 'string' ? [input.path] : []
  if (typeof input.input === 'string') for (const m of input.input.matchAll(/^\[(.+?)#[0-9A-Fa-f]{4}\]/gm)) paths.push(m[1] ?? '')
  return [...new Set(paths.filter(p => p !== '').map(p => (isAbsolute(p) ? p : resolve(cwd, p))))]
}

// Turns, main model and first prompt, from the session's entries.
export function sessionStats(entries: Entry[]) {
  let turns = 0
  let first = ''
  const models = new Map<string, number>()
  for (const e of entries) {
    if (e.type !== 'message' || !e.message) continue
    if (e.message.role === 'user') {
      turns++
      if (first === '') first = text(e.message.content).split('\n')[0] ?? ''
    }
    const model = e.message.model
    if (e.message.role === 'assistant' && model) models.set(model, (models.get(model) ?? 0) + 1)
  }
  const model = [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  return { turns, model, first }
}

export default function ponytailBand(pi: Pi) {
  const pending = new Map<string, { file: string; before: string }[]>()
  let startedRun = 0

  const git = (args: string[], cwd: string) => pi.exec('git', args, { cwd }).catch(() => ({ stdout: '', code: -1 }))

  // The task this session counts into: its own, or the parent's when it is a subagent.
  async function task(ctx: Ctx): Promise<Task> {
    const sm = ctx.sessionManager
    const file = sm.getSessionFile() ?? sm.getSessionId()
    const own = tasks.get(file)
    if (own) return own
    const parent = sm.getHeader()?.parentSession
    const inherited = parent ? tasks.get(parent) : undefined
    if (inherited) {
      tasks.set(file, inherited)
      return inherited
    }
    // --show-cdup, not --show-toplevel: the root keeps cwd's form, so a symlinked cwd (macOS /var -> /private/var) still matches edit paths.
    const top = await git(['rev-parse', '--show-cdup'], ctx.cwd)
    const root = top.code === 0 ? resolve(ctx.cwd, top.stdout.trim()) : ctx.cwd
    const t: Task = {
      root,
      project: basename(root),
      // Definitions that exist before the task: what new code can reuse.
      known: git(['grep', '--untracked', '-nE', GREP_DEFS], root).then(r => (r.code === 0 ? parseDefs(r.stdout) : new Map())),
      reused: [],
      created: [],
      removed: [],
      openCallers: [],
      tests: { state: 'none' },
      busyMs: 0,
      name: '',
    }
    // A restart mid-session picks up the agent time the ledger already has for it.
    const header = sm.getHeader()
    if (header) {
      const key = taskKey(sm.getSessionId(), Date.parse(header.timestamp))
      const b = resume({ busyMs: 0, name: '', tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Band, readText(ledgerFile(ledgerDir(), t.project)), key)
      t.busyMs = b.busyMs
      t.name = b.name
    }
    tasks.set(file, t)
    return t
  }

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'edit' && event.toolName !== 'write') return
    const t = await task(ctx)
    // A scratch file outside the project is never reused or called by it (#1300).
    const files = editPaths(event.input ?? {}, ctx.cwd).filter(f => inProject(f, t.root))
    if (files.length > 0) pending.set(event.toolCallId, files.map(file => ({ file, before: readText(file) })))
  })

  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName === 'bash') {
      const command = String(event.input?.command ?? '')
      if (!isTestCommand(command)) return
      const t = await task(ctx)
      t.tests = { state: event.isError ? 'fail' : 'pass', ...testCounts(text(event.content)) }
      return
    }
    const edits = pending.get(event.toolCallId)
    if (!edits) return
    pending.delete(event.toolCallId)
    if (event.isError) return
    const t = await task(ctx)
    const known = await t.known
    for (const { file, before } of edits) {
      const after = readText(file)
      const oldDefs = defsIn(file, before)
      const newDefs = defsIn(file, after)
      t.created = union(t.created, isSource(file) ? newDefs.filter(n => !oldDefs.includes(n)) : [])
      t.removed = union(t.removed, oldDefs.filter(n => !newDefs.includes(n)))
      t.reused = union(t.reused, isSource(file) ? callsIn(addedLines(before, after), known, newDefs) : [])
      if (isCode(file) && t.tests.state !== 'none') t.tests = { ...t.tests, state: 'stale' }
    }
  })

  pi.on('agent_start', () => {
    startedRun = Date.now()
  })

  // session_stop, not agent_end: omp awaits it before the run settles, while `omp -p` can exit with an agent_end handler still running.
  // shortcut: a run stopped with Esc may skip session_stop, so its row catches up at the next prompt; also record on agent_end if that matters.
  pi.on('session_stop', async (_event, ctx) => {
    const sm = ctx.sessionManager
    // A subagent's cost and tokens reach the parent through its task result; only the main session writes the row.
    if (sm.getHeader()?.parentSession || typeof sm.getUsageStatistics !== 'function') return
    const t = await task(ctx)
    if (startedRun > 0) t.busyMs += Date.now() - startedRun
    startedRun = 0

    // A removed or renamed definition that is not defined again but still called somewhere.
    // shortcut: name match with git grep, so a same-named call in another module counts too.
    const stillRemoved: string[] = []
    const open: string[] = []
    for (const name of t.removed) {
      const rows = hits((await git(['grep', '--untracked', '-nw', '-e', name], t.root)).stdout)
      if (rows.some(r => defsIn(r.file, r.text.trimStart()).includes(name))) continue
      const call = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}\\s*\\(`)
      const refs = rows.filter(r => call.test(r.text)).map(r => `${r.file}:${r.line}`)
      if (refs.length > 0) {
        stillRemoved.push(name)
        open.push(...refs)
      }
    }
    t.removed = stillRemoved
    t.openCallers = open

    const header = sm.getHeader()
    if (!header) return
    const usage = sm.getUsageStatistics()
    const stats = sessionStats(sm.getEntries())
    t.name = clean(pi.getSessionName() ?? '') || t.name || clean(stats.first)
    const band: Band = {
      level: resolveSessionMode(sm.getBranch(), readDefaultMode()),
      model: stats.model,
      cost: usage.cost,
      spent: usage.cost,
      turns: stats.turns,
      turnCosts: [],
      tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
      busyMs: t.busyMs,
      name: t.name,
      project: t.project,
      session: sm.getSessionId(),
      transcript: sm.getSessionFile() ?? '',
      reused: t.reused,
      created: t.created,
      removed: t.removed,
      openCallers: t.openCallers,
      tests: t.tests,
      details: false,
    }
    const row = snapshot(band, Date.parse(header.timestamp))
    const config = bandConfig()
    if (config.ledger) {
      try {
        const dir = ledgerDir()
        mkdirSync(dir, { recursive: true })
        const file = ledgerFile(dir, t.project)
        writeFileSync(file, upsertCsv(readText(file), row))
        // The board is a plain file a refresh rereads, so it is rebuilt with every row.
        writeBoard(dir)
      } catch {
        ctx.ui?.setStatus?.('ponytail-band', 'ponytail band: could not write the task ledger')
      }
    }
    await send(row, ctx, config)
  })

  // No argument: build the board fresh and open it. on/off: switch the ledger (the webhook stays as set).
  pi.registerCommand('ponytail-board', {
    description: 'Open the task board. on|off: switch the task ledger',
    getArgumentCompletions: prefix => ['on', 'off'].filter(v => v.startsWith(prefix.trim())).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase()
      if (arg === 'on' || arg === 'off') {
        writeLedger(arg === 'on')
        ctx.ui?.notify?.(arg === 'on' ? 'Task ledger on: every prompt writes its row.' : 'Task ledger off: no rows are written.', 'info')
        return
      }
      try {
        const file = writeBoard(ledgerDir())
        // An empty title for `start`, which otherwise takes a quoted path as the window title.
        const opened =
          process.platform === 'win32' ? await pi.exec('cmd', ['/c', 'start', '', file]) : await pi.exec(process.platform === 'darwin' ? 'open' : 'xdg-open', [file])
        if (opened.code !== 0) ctx.ui?.notify?.(`Board written to ${file}; could not open a browser.`, 'warning')
      } catch {
        ctx.ui?.notify?.('ponytail band: could not open the board', 'error')
      }
    },
  })
}
