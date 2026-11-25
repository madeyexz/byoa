// The table of harness adapters (harness/types.ts). Everything outside harness/ asks it, and names no harness.
import { SERVER_NAME, SKILL_NAME, type Access, type Setup } from '../config.ts'
import type { Sandbox } from '../sandbox/types.ts'
import { claude } from './claude.ts'
import { codex } from './codex.ts'
import { fake } from './fake.ts'
import { grok } from './grok.ts'
import type { Installed } from './install.ts'
import { PACKAGES, PINS, type HarnessName, type Pins } from './pins.ts'
import type { Harness, LabHarness, RunHarness } from './types.ts'

export const HARNESSES: Record<HarnessName, LabHarness> = { claude, codex, grok }
const ALL: Record<RunHarness, Harness> = { ...HARNESSES, fake }

/** The adapter of a harness; an unknown name is an error, never another harness's behavior. */
export function harness(h: RunHarness): Harness {
  if (!Object.prototype.hasOwnProperty.call(ALL, h)) throw new Error(`byoa: harness: ${Object.keys(ALL).join(', ')}`)
  return ALL[h]
}
export const isLab = (h: unknown): h is HarnessName => Object.prototype.hasOwnProperty.call(HARNESSES, h as string)

/** @internal The pinned, unmodified harness in the sandbox, installed from npm when it is not there (R5.1, R5.2). */
export const ensureHarness = (sbx: Sandbox, h: HarnessName, pins: Pins = PINS): Promise<Installed> => HARNESSES[h].install(sbx, pins)

/** @internal Every harness's npm package and pin, and what their install needs (for a provider template). */
export const npmInstall = (pins: Pins = PINS) => ({
  specs: (Object.keys(HARNESSES) as HarnessName[]).map((h) => `${PACKAGES[h]}@${pins[h]}`),
  env: Object.assign({}, ...Object.values(HARNESSES).map((x) => x.npm?.env ?? {})) as Record<string, string>,
  after: Object.values(HARNESSES).flatMap((x) => (x.npm ? [x.npm.after] : [])),
})

/** The environment that points the harness at its folder in `home` (the sandbox's home folder), with its own settings. */
export const harnessEnv = (home: string, x: Harness): Record<string, string> => ({ [x.home.env]: `${home}/${x.home.dir}`, ...x.env })

/** @internal The files byoa writes into the job's folder for a harness (R4): skills in the Agent Skills format,
 *  AGENTS.md (and CLAUDE.md for Claude Code), and the MCP config in the harness's own format. Each MCP server points to
 *  the app's proxy (R3.1); the token is the job's, read from an environment variable, never a real one. A pure
 *  function, so V10 compares its output with the expected files byte for byte. Paths are relative to the job's
 *  folder. `servers`: the MCP server names this job gets (R2.5). */
export function harnessFiles(h: RunHarness, setup: Setup, o: { proxyUrl: string; servers: string[]; access?: Access }): Record<string, string> {
  const x = harness(h)
  const files: Record<string, string> = {}
  const servers = [...o.servers].sort()
  for (const s of servers) if (!SERVER_NAME.test(s)) throw new Error(`byoa: MCP server name ${JSON.stringify(s)}: lower-case letters, digits and -, at most 32`)
  if (setup.agentsMd !== undefined) {
    files['AGENTS.md'] = setup.agentsMd
    if (x.files.claudeMd) files['CLAUDE.md'] = setup.agentsMd
  }
  for (const sk of setup.skills ?? []) {
    if (!SKILL_NAME.test(sk.name)) throw new Error(`byoa: skill name ${JSON.stringify(sk.name)}: lower-case letters, digits and -, at most 64`)
    if (typeof sk.files['SKILL.md'] !== 'string') throw new Error(`byoa: skill ${sk.name} has no SKILL.md`)
    for (const [p, text] of Object.entries(sk.files)) {
      if (p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '')) throw new Error(`byoa: skill ${sk.name}: bad path ${p}`)
      files[`${x.files.skills}/${sk.name}/${p}`] = text
    }
  }
  const mcp = x.files.mcp(servers, o)
  if (mcp !== undefined) files[x.files.mcpPath] = mcp
  return files
}

/** The paths in the job's folder that hold byoa's setup for any harness: removed before a job writes its own. */
export const SETUP_PATHS = [...new Set(['AGENTS.md', 'CLAUDE.md', '.byoa', ...Object.values(ALL).flatMap((x) => [x.files.skills, x.files.mcpPath])])]
