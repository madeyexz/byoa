// The files byoa writes into the job's folder for each harness (R4), from one setup: skills in the Agent Skills
// format, AGENTS.md (and CLAUDE.md for Claude Code), and the MCP config in each harness's own format. Each MCP server
// points to the app's proxy (R3.1); the token is the job's, read from an environment variable, never a real one.
// A pure function, so V10 can compare its output with the expected files byte for byte.
import type { HarnessName } from './harness/pins.ts'

export interface Skill {
  name: string
  /** Paths inside the skill folder → contents. `SKILL.md` is required. */
  files: Record<string, string>
}

export interface Setup {
  /** The job's AGENTS.md. Claude Code gets the same text as CLAUDE.md. */
  agentsMd?: string
  skills?: Skill[]
}

/** The environment variable that carries the job token to the harness. */
export const JOB_TOKEN_ENV = 'BYOA_JOB_TOKEN'
/** Where the Claude Code MCP config goes, relative to the job's folder. */
export const CLAUDE_MCP_CONFIG = '.byoa/mcp.json'

/** A name both harnesses take as an MCP server name and a tool prefix. */
export const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
/** Agent Skills names: lower-case letters, digits and single hyphens, at most 64. */
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]?$/

export function serverUrl(proxyUrl: string, server: string) {
  return `${proxyUrl.replace(/\/+$/, '')}/${server}`
}

/** Paths relative to the job's folder → contents. `servers`: the MCP server names this job gets (R2.5). */
export function harnessFiles(harness: HarnessName, setup: Setup, o: { proxyUrl: string; servers: string[] }): Record<string, string> {
  const files: Record<string, string> = {}
  const servers = [...o.servers].sort()
  for (const s of servers) if (!SERVER_NAME.test(s)) throw new Error(`byoa: MCP server name ${JSON.stringify(s)}: lower-case letters, digits and -, at most 32`)

  if (setup.agentsMd !== undefined) {
    files['AGENTS.md'] = setup.agentsMd
    if (harness === 'claude') files['CLAUDE.md'] = setup.agentsMd
  }

  const skillsDir = harness === 'claude' ? '.claude/skills' : '.agents/skills'
  for (const sk of setup.skills ?? []) {
    if (!SKILL_NAME.test(sk.name)) throw new Error(`byoa: skill name ${JSON.stringify(sk.name)}: lower-case letters, digits and -, at most 64`)
    if (typeof sk.files['SKILL.md'] !== 'string') throw new Error(`byoa: skill ${sk.name} has no SKILL.md`)
    for (const [p, text] of Object.entries(sk.files)) {
      if (p.startsWith('/') || p.split('/').some((x) => x === '..' || x === '')) throw new Error(`byoa: skill ${sk.name}: bad path ${p}`)
      files[`${skillsDir}/${sk.name}/${p}`] = text
    }
  }

  if (harness === 'claude') {
    const mcpServers = Object.fromEntries(servers.map((s) => [s, {
      type: 'http',
      url: serverUrl(o.proxyUrl, s),
      headers: { Authorization: `Bearer \${${JOB_TOKEN_ENV}}` },
    }]))
    files[CLAUDE_MCP_CONFIG] = JSON.stringify({ mcpServers }, null, 2) + '\n'
  } else if (servers.length) {
    files['.codex/config.toml'] = servers.map((s) =>
      `[mcp_servers.${s}]\nurl = ${tomlString(serverUrl(o.proxyUrl, s))}\nbearer_token_env_var = "${JOB_TOKEN_ENV}"\n`).join('\n')
  }
  return files
}

function tomlString(s: string) {
  return '"' + s.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => c === '\\' ? '\\\\' : c === '"' ? '\\"' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '"'
}

// ---- Agent Plugins 1.0 (R4.4): plugin.json, skills/<name>/..., mcp.json

export interface Plugin {
  name: string
  setup: Setup
  /** The plugin's Streamable HTTP servers. A job with this plugin gets each one through the user's grant of the same
   *  name (connectMcp); byoa never sends the plugin's URL to the harness, only the proxy's. */
  mcp: { name: string; url: string }[]
  /** What byoa did not load, such as stdio servers (they would run inside the sandbox with no proxy). */
  skipped: string[]
}

/** `files`: the plugin's files, paths relative to its root (see `readPluginDir` in byoa/node). */
export function readPlugin(files: Record<string, string>): Plugin {
  const manifest = JSON.parse(files['plugin.json'] ?? 'null')
  if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string') throw new Error('byoa: plugin.json must be an object with a name')
  const skipped: string[] = []
  const bySkill = new Map<string, Record<string, string>>()
  for (const [p, text] of Object.entries(files)) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(p)
    if (!m) continue
    if (!bySkill.has(m[1])) bySkill.set(m[1], {})
    bySkill.get(m[1])![m[2]] = text
  }
  const skills: Skill[] = []
  for (const [name, f] of [...bySkill].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (typeof f['SKILL.md'] !== 'string') continue
    if (!SKILL_NAME.test(name)) { skipped.push(`skill ${name}: not an Agent Skills name`); continue }
    skills.push({ name, files: f })
  }
  const mcp: Plugin['mcp'] = []
  if (files['mcp.json'] !== undefined) {
    const doc = JSON.parse(files['mcp.json'])
    for (const [name, s] of Object.entries<any>(doc?.mcpServers ?? {})) {
      if ((s?.type === 'streamable-http' || s?.type === 'http') && typeof s.url === 'string' && SERVER_NAME.test(name)) mcp.push({ name, url: s.url })
      else skipped.push(`mcp server ${name}: only Streamable HTTP servers are supported`)
    }
  }
  return { name: manifest.name, setup: { skills }, mcp, skipped }
}
