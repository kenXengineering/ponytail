// The band's task ledger for Oh My Pi (omp, and Tern, which runs omp): the same CSV rows and
// board.html the Claude Code band writes, from omp's extension events and session manager.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'

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
  taskKey,
  testCounts,
  upsertCsv,
} from '../hooks/band/metrics'
import { readDefaultMode, resolveSessionMode } from './index.js'

type Entry = { type: string; message?: { role?: string; model?: string; content?: unknown } }
type Ctx = {
  cwd: string
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

  pi.on('agent_end', async (_event, ctx) => {
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
    try {
      const dir = ledgerDir()
      mkdirSync(dir, { recursive: true })
      const file = ledgerFile(dir, t.project)
      writeFileSync(file, upsertCsv(readText(file), snapshot(band, Date.parse(header.timestamp))))
      // The board is a plain file a refresh rereads, so it is rebuilt with every row.
      const csvs = readdirSync(dir).filter(f => f.endsWith('.csv')).map(f => readText(join(dir, f)))
      writeFileSync(join(dir, 'board.html'), boardHtml(csvs.flatMap(tasksFrom), Date.now()))
    } catch {
      // A ledger that cannot be written must never break the turn.
    }
  })
}
