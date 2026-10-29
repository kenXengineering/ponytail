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

test('a turn writes the task row and board.html, counting reuse, new code and tests', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'ponytail-repo-'))
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo })
  sh('init', '-q')
  writeFileSync(join(repo, 'util.js'), 'export function sumPrices(xs) {\n  return xs.reduce((a, b) => a + b, 0)\n}\n')
  sh('add', '.')

  const handlers = new Map<string, Function>()
  ponytailBand({
    on: (name: string, fn: Function) => handlers.set(name, fn),
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
    sessionManager: {
      getSessionId: () => '01abcdef-0000',
      getSessionFile: () => join(repo, 's.jsonl'),
      getHeader: () => ({ timestamp: '2026-10-29T10:00:00.000Z' }),
      getEntries: () => entries,
      getBranch: () => entries,
      getUsageStatistics: () => ({ input: 10, output: 20, cacheRead: 300, cacheWrite: 40, cost: 1.234 }),
    },
  }
  const file = join(repo, 'cart.js')
  const content = "import { sumPrices } from './util.js'\nexport function total(c) { return sumPrices(c.items) }\nexport function tax(c) { return total(c) * 0.2 }\n"
  await handlers.get('agent_start')!({}, ctx)
  await handlers.get('tool_call')!({ toolName: 'write', toolCallId: 'w1', input: { path: 'cart.js', content } }, ctx)
  writeFileSync(file, content)
  await handlers.get('tool_result')!({ toolName: 'write', toolCallId: 'w1', input: {}, content: [], isError: false }, ctx)
  await handlers.get('tool_result')!({ toolName: 'bash', toolCallId: 'b1', input: { command: 'npm test' }, content: [{ type: 'text', text: '7 passed' }], isError: false }, ctx)
  await handlers.get('agent_end')!({}, ctx)

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
  await handlers.get('agent_end')!({}, child)
  await handlers.get('agent_end')!({}, ctx)
  const rows = readFileSync(join(config, 'ponytail', 'band', `${repo.split('/').pop()}.csv`), 'utf8').trim().split('\n')
  expect(rows).toHaveLength(2)
  expect(rows[1]!.split(',')[13]).toBe('2 failed')
})
