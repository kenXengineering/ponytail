// Run with `bun test pi-extension/test/band.test.ts`: the band imports the TypeScript band helpers, which node --test cannot resolve.
import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import ponytailBand, { editPaths, sessionStats } from '../band.ts'

const config = mkdtempSync(join(tmpdir(), 'ponytail-band-'))
process.env.XDG_CONFIG_HOME = config

test('editPaths reads write paths and hashline headers, resolved against cwd', () => {
  expect(editPaths({ path: 'a.ts' }, '/r')).toEqual(['/r/a.ts'])
  expect(editPaths({ input: '[src/x.js#1A2B]\nPUT 1:\n+y\n[/abs/z.py#FFFF]\nCUT 2' }, '/r')).toEqual(['/r/src/x.js', '/abs/z.py'])
})

test('sessionStats counts prompts and picks the model of most replies', () => {
  const user = (content: unknown) => ({ type: 'message', message: { role: 'user', content } })
  const reply = (model: string) => ({ type: 'message', message: { role: 'assistant', model } })
  const s = sessionStats([user([{ type: 'text', text: 'fix it\nmore' }]), reply('a'), reply('b'), reply('b'), user('again'), { type: 'custom' }])
  expect(s).toEqual({ turns: 2, model: 'b', first: 'fix it' })
})

// A git repo with one helper to reuse, the band registered against a fake omp, and a main session in it.
function setup(session: string) {
  const repo = mkdtempSync(join(tmpdir(), 'ponytail-repo-'))
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo })
  sh('init', '-q')
  writeFileSync(join(repo, 'util.js'), 'export function sumPrices(xs) {\n  return xs.reduce((a, b) => a + b, 0)\n}\n')
  sh('add', '.')

  const handlers = new Map<string, Function>()
  const commands = new Map<string, { handler: Function }>()
  const status: (string | undefined)[] = []
  let statusSet = () => {}
  // Resolves on the next status the band sets: the webhook's answer arrives after session_stop returns.
  const nextStatus = () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    statusSet = resolve
    return promise
  }
  ponytailBand({
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (name: string, options: { handler: Function }) => commands.set(name, options),
    exec: async (cmd: string, args: string[], opts?: { cwd?: string }) => {
      try {
        return { stdout: execFileSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8' }), code: 0 }
      } catch {
        return { stdout: '', code: 1 }
      }
    },
    getSessionName: () => '\u{F06E2} Checkout totals',
  })
  const entries = [
    { type: 'message', message: { role: 'user', content: 'add a checkout total' } },
    { type: 'message', message: { role: 'assistant', model: 'claude-opus-5-5' } },
  ]
  const ctx = {
    cwd: repo,
    ui: { notify() {}, setStatus: (_key: string, text: string | undefined) => (status.push(text), statusSet()) },
    sessionManager: {
      getSessionId: () => session,
      getSessionFile: () => join(repo, 's.jsonl'),
      getHeader: () => ({ timestamp: '2026-10-29T10:00:00.000Z' }),
      getEntries: () => entries,
      getBranch: () => entries,
      getUsageStatistics: () => ({ input: 10, output: 20, cacheRead: 300, cacheWrite: 40, cost: 1.234 }),
    },
  }
  return { repo, handlers, commands, ctx, status, nextStatus, ledger: join(config, 'ponytail', 'band', `${repo.split('/').pop()}.csv`) }
}

test('a turn writes the task row and board.html, counting reuse, new code and tests', async () => {
  const { repo, handlers, ctx } = setup('01abcdef-0000')
  const file = join(repo, 'cart.js')
  const content = "import { sumPrices } from './util.js'\nexport function total(c) { return sumPrices(c.items) }\nexport function tax(c) { return total(c) * 0.2 }\n"
  await handlers.get('agent_start')!({}, ctx)
  await handlers.get('tool_call')!({ toolName: 'write', toolCallId: 'w1', input: { path: 'cart.js', content } }, ctx)
  writeFileSync(file, content)
  await handlers.get('tool_result')!({ toolName: 'write', toolCallId: 'w1', input: {}, content: [], isError: false }, ctx)
  await handlers.get('tool_result')!({ toolName: 'bash', toolCallId: 'b1', input: { command: 'npm test' }, content: [{ type: 'text', text: '7 passed' }], isError: false }, ctx)
  await handlers.get('session_stop')!({}, ctx)

  const csv = readFileSync(join(config, 'ponytail', 'band', `${repo.split('/').pop()}.csv`), 'utf8').trim().split('\n')
  expect(csv[0]).toStartWith('key,started,project,name,cost_usd')
  const row = csv[1]!.split(',')
  expect(row[0]).toBe(`01abcdef-${Date.parse('2026-10-29T10:00:00.000Z')}`)
  expect(row[3]).toBe('Checkout totals')
  expect(row[4]).toBe('1.23')
  expect(row[7]).toBe('370')
  // sumPrices reused; total and tax new.
  expect(row.slice(9, 12)).toEqual(['33', '1', '2'])
  expect(row[13]).toBe('7 passed')
  expect(row[15]).toBe('claude-opus-5-5')
  expect(existsSync(join(config, 'ponytail', 'band', 'board.html'))).toBe(true)

  // A subagent's turn counts into its parent's task and never writes its own row.
  const child = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionFile: () => join(repo, 'child.jsonl'), getHeader: () => ({ timestamp: 'x', parentSession: join(repo, 's.jsonl') }) } }
  await handlers.get('tool_result')!({ toolName: 'bash', toolCallId: 'b2', input: { command: 'npm test' }, content: [{ type: 'text', text: '2 failed' }], isError: true }, child)
  await handlers.get('session_stop')!({}, child)
  await handlers.get('session_stop')!({}, ctx)
  const rows = readFileSync(join(config, 'ponytail', 'band', `${repo.split('/').pop()}.csv`), 'utf8').trim().split('\n')
  expect(rows).toHaveLength(2)
  expect(rows[1]!.split(',')[13]).toBe('2 failed')
})

test('ponytail-board off stops the ledger, the webhook still gets the row with its token', async () => {
  const { handlers, commands, ctx, status, nextStatus, ledger } = setup('02abcdef-0000')
  const got: { auth: string | null; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async req => {
      got.push({ auth: req.headers.get('authorization'), body: await req.json() })
      return new Response('ok')
    },
  })
  try {
    await commands.get('ponytail-board')!.handler('off', ctx)
    const file = join(config, 'ponytail', 'config.json')
    writeFileSync(file, JSON.stringify({ defaultMode: 'lite', band: { ...JSON.parse(readFileSync(file, 'utf8')).band, webhookUrl: `http://localhost:${server.port}/hook`, sendNames: false } }))
    process.env.PONYTAIL_WEBHOOK_TOKEN = 'secret'
    const answered = nextStatus()
    await handlers.get('session_stop')!({}, ctx)
    await answered

    expect(existsSync(ledger)).toBe(false)
    expect(got).toHaveLength(1)
    expect(got[0]!.auth).toBe('Bearer secret')
    expect(got[0]!.body.name).toBe('')
    expect(got[0]!.body.cost).toBe(1.234)
    expect(status.at(-1)).toBeUndefined()

    // Plain http to another host would send the token in the clear: refused, and said so.
    writeFileSync(file, JSON.stringify({ band: { ledger: false, webhookUrl: 'http://example.com/hook' } }))
    await handlers.get('session_stop')!({}, ctx)
    expect(status.at(-1)).toBe('ponytail band: webhook needs https')
    expect(got).toHaveLength(1)

    // Back on: the switch keeps the other keys of config.json.
    writeFileSync(file, JSON.stringify({ defaultMode: 'lite', band: { ledger: false } }))
    await commands.get('ponytail-board')!.handler('on', ctx)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ defaultMode: 'lite', band: { ledger: true } })
    await handlers.get('session_stop')!({}, ctx)
    expect(existsSync(ledger)).toBe(true)
  } finally {
    server.stop(true)
    delete process.env.PONYTAIL_WEBHOOK_TOKEN
  }
})
