// V10: for a sample plugin, the files byoa writes match the expected files for each harness, byte for byte (R4).
// The expected files in test/fixtures/expected were written by hand, not by byoa.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { harnessFiles, readPlugin } from '../src/config.ts'
import { readPluginDir } from '../src/node.ts'

const FIX = new URL('./fixtures/', import.meta.url).pathname
const PROXY = 'https://app.example.com/byoa/mcp/'

function write(h: 'claude' | 'codex') {
  const plugin = readPlugin(readPluginDir(join(FIX, 'sample-plugin')))
  const setup = { agentsMd: readFileSync(join(FIX, 'AGENTS.md'), 'utf8'), skills: plugin.setup.skills }
  // the job asks for linear itself; the plugin brings notion
  return { plugin, files: harnessFiles(h, setup, { proxyUrl: PROXY, servers: ['notion', 'linear'] }) }
}

for (const h of ['claude', 'codex'] as const) {
  test(`V10: ${h} files match the expected files byte for byte`, () => {
    const { files } = write(h)
    const expected = readPluginDir(join(FIX, 'expected', h))
    assert.deepEqual(Object.keys(files).sort(), Object.keys(expected).sort())
    for (const [p, text] of Object.entries(expected)) assert.equal(files[p], text, p)
  })
}

test('V10: the plugin reader takes Streamable HTTP servers and Agent Skills names only, and says what it skipped', () => {
  const { plugin } = write('claude')
  assert.equal(plugin.name, 'reading-tools')
  assert.deepEqual(plugin.mcp, [{ name: 'notion', url: 'https://mcp.notion.com/mcp' }])
  assert.deepEqual(plugin.setup.skills!.map((s) => s.name), ['summarize'])
  assert.deepEqual(plugin.skipped.sort(), ['mcp server local-files: only Streamable HTTP servers are supported', 'skill Bad_Name: not an Agent Skills name'])
})

test('config: a job with no MCP servers gets an empty Claude config and no Codex config', () => {
  assert.equal(harnessFiles('claude', {}, { proxyUrl: PROXY, servers: [] })['.byoa/mcp.json'], '{\n  "mcpServers": {}\n}\n')
  assert.deepEqual(harnessFiles('codex', {}, { proxyUrl: PROXY, servers: [] }), {})
})

test('config: a skill path that leaves its folder is refused', () => {
  assert.throws(() => harnessFiles('claude', { skills: [{ name: 'x', files: { 'SKILL.md': '', '../../.bashrc': 'evil' } }] }, { proxyUrl: PROXY, servers: [] }), /bad path/)
})

// The real Codex binary reads the TOML byoa writes (only when a codex binary is given, as in CI).
const codex = process.env.BYOA_CODEX_BIN
test('V10: the pinned Codex reads the config.toml byoa writes', { skip: !codex && 'set BYOA_CODEX_BIN to check with the real Codex' }, () => {
  const work = mkdtempSync(join(tmpdir(), 'byoa-v10-')), home = join(work, 'codex-home')
  mkdirSync(home)
  for (const [p, text] of Object.entries(write('codex').files)) { mkdirSync(dirname(join(work, 'job', p)), { recursive: true }); writeFileSync(join(work, 'job', p), text) }
  const out = execFileSync(codex!, ['-c', `projects={${JSON.stringify(join(work, 'job'))}={trust_level="trusted"}}`, 'mcp', 'list', '--json'], { cwd: join(work, 'job'), env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8' })
  const list = JSON.parse(out) as { name: string; transport: { type: string; url: string; bearer_token_env_var: string }; startup_timeout_sec: number | null }[]
  // startup_timeout_sec: Codex waits that long for a server whose first request waits on a refresh at the proxy;
  // with a key Codex does not know, it reports null and waits its default 10 s
  assert.deepEqual(list.map((s) => [s.name, s.transport.type, s.transport.url, s.transport.bearer_token_env_var, s.startup_timeout_sec]).sort(), [
    ['linear', 'streamable_http', 'https://app.example.com/byoa/mcp/linear', 'BYOA_JOB_TOKEN', 60],
    ['notion', 'streamable_http', 'https://app.example.com/byoa/mcp/notion', 'BYOA_JOB_TOKEN', 60],
  ])
})
