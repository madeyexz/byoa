// The setup of a job (R4): skills in the Agent Skills format, AGENTS.md, and Agent Plugins; and the names that every
// harness's MCP config shares. harness/files.ts writes them in each harness's own format.

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
/** How long each harness waits for each MCP server to start, in seconds. The proxy holds a server's first request
 *  while the grant's one refresh runs, which can take up to 60 s (mcp/grants.ts), and byoa's check before the harness
 *  waits 70 s (R3.5). A harness that stops waiting leaves the server's tools out of the job, with no error, and the job
 *  still ends well. Codex: `startup_timeout_sec` (its own default is 10); it also waits for all optional servers
 *  together only 1 s by default (`mcp_optional_startup_grace_ms`), so byoa sets that to 0, and Codex waits each
 *  server's own timeout. Claude Code: the MCP_TIMEOUT environment variable, in ms (its own default is 30 s; checked
 *  with 2.1.330, which drops a server that takes 40 s to answer `initialize`). */
export const MCP_STARTUP_SEC = 60
/** The MCP protocol version of byoa's own MCP requests (connectMcp's probe, the check from the sandbox, the fake
 *  harness). */
export const MCP_PROTOCOL = '2025-06-18'

/** A name every harness takes as an MCP server name and a tool prefix. */
export const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
/** Agent Skills names: lower-case letters, digits and single hyphens, at most 64. */
export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]?$/

export function serverUrl(proxyUrl: string, server: string) {
  return `${proxyUrl.replace(/\/+$/, '')}/${server}`
}

/** What the agent of a job may do (R5.6). `full` (the default): every tool of the harness, with no approval, so the
 *  sandbox is the only limit; for a sandbox that is the job's alone. `read-only`: the job's MCP tools, and reading
 *  files (so the harness can read its skills and AGENTS.md); it cannot change a file or reach the network by itself.
 *  byoa only sets each CLI's own flags for this (each adapter in harness/). */
export type Access = 'full' | 'read-only'
export const ACCESS: Access[] = ['full', 'read-only']

export function tomlString(s: string) {
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
    const [, skill, rest] = m as unknown as [string, string, string]
    if (!bySkill.has(skill)) bySkill.set(skill, {})
    bySkill.get(skill)![rest] = text
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
