// One adapter for each harness: everything byoa knows about a CLI, in one object. The rest of byoa asks the table in
// harness/index.ts and names no harness, so a new harness is one new adapter, and an adapter that leaves a part out is
// a type error, not another harness's behavior. Internal: an app cannot add a harness, because the Lab rules need a
// check of each binary (V11).
import type { Access } from '../config.ts'
import type { Sandbox } from '../sandbox/types.ts'
import type { EventReader } from './events.ts'
import type { Installed } from './install.ts'
import type { ModelInfo } from './models.ts'
import type { HarnessName, Pins } from './pins.ts'

export type RunHarness = HarnessName | 'fake'

/** `model`: Claude Code's alias (`opus`, `sonnet`, ...) or a full model name; Codex's or Grok's model name. `effort`:
 *  Claude Code's `--effort` (low, medium, high, xhigh, max); Codex's `model_reasoning_effort`; Grok's
 *  `--reasoning-effort`. Each model's own efforts are in listModels. */
export interface ModelChoice { model?: string; effort?: string }

/** One job of a conversation (R5.9): the harness's own session id (none yet for a new Codex thread, which names its
 *  own), and whether the session has turns already. */
export interface Turn { session?: string; resume: boolean }

export interface JobArgs {
  /** The job's folder (its cwd). */
  work: string
  access?: Access
  /** The job's MCP servers. */
  servers: string[]
  /** The flags of the job's model and effort (modelArgs, or a plan's). */
  model: string[]
  conversation?: Turn
}

export interface LoginSpec {
  /** The CLI's own login files, relative to the home folder; the first one must be there for a login. */
  files: string[]
  /** Copies of the login files that the CLI makes by itself, as shell globs relative to the home folder: byoa removes
   *  them with the login files and does not store them. */
  copies?: string[]
  /** The lab's sign-in page in the CLI's output. */
  url: RegExp
  /** The CLI's sign-in and sign-out, after its binary. */
  signIn: string
  signOut: string
  /** The CLI shows a page and a code and finishes by itself (a device code); else it takes the code the page shows. */
  device: boolean
  /** When the CLI will refresh this login by itself (ms since 1970), from the times in its files; 0 when unknown. */
  refreshDue(files: Record<string, string>): number
  /** Whose login it is, and how new it is (ms since 1970; 0 when unknown). byoa reads no token. */
  facts(files: Record<string, string>): { account?: string; fresh: number }
}

/** How a harness runs with a plan that the user brought as a key (R1.8). `base`: the relay for this job; `home`: the
 *  sandbox's home folder. */
export interface PlanRun { base: string; token: string; home: string; model: string; effort?: string }
export interface PlanSettings { env: Record<string, string>; args: string[]; dirs: string[] }

export interface Harness {
  name: RunHarness
  /** The folder in the home folder where the CLI keeps its login, sessions and settings (also the mount path of a
   *  login volume), and the variable that points the CLI there. */
  home: { dir: string; env: string }
  /** More of the harness's environment, wherever it runs, such as no self-update (byoa runs the pinned version, R5.1). */
  env: Record<string, string>
  /** More of its environment in a job only. */
  jobEnv?: Record<string, string>
  /** What its npm install needs: more environment, and a command after it (Grok's postinstall, harness/grok.ts). */
  npm?: { env: Record<string, string>; after: string }
  /** The pinned binary in the sandbox, installed when it is not there (R5.1, R5.2). */
  install(sbx: Sandbox, pins: Pins): Promise<Installed>
  /** The command line of a job: the binary and the flags. */
  command(bin: string, args: string[]): string[]
  /** The flags of a job (R5.6, R5.9). */
  args(o: JobArgs): string[]
  /** The flags of a model and effort (R5.7). */
  modelArgs(m: ModelChoice): string[]
  /** Its output, one line at a time, into byoa's events (R5.5). `plan`: the job runs with a plan's key. */
  reader(o?: { plan?: boolean }): EventReader
  /** The files in the job's folder for this harness (R4): where it reads skills, whether it reads CLAUDE.md, and its
   *  MCP config at `mcpPath`. */
  files: {
    skills: string
    claudeMd: boolean
    mcpPath: string
    mcp(servers: string[], o: { proxyUrl: string; access?: Access }): string | undefined
  }
  /** `text`: the task on stdin, read to its end. `stream-json`: the task and each later message as a stream-json line,
   *  so a running job takes more messages (R5.10). */
  input: 'text' | 'stream-json'
  /** How it keeps a conversation (R5.9). `choose`: byoa picks the session id of a new conversation (a UUID); else the
   *  harness names it, and its reader reports it. `transcript`: the session's files, as `find -path` patterns relative
   *  to the harness's home folder. `byFolder`: it keeps its sessions under the job folder's path, so a stored
   *  transcript resumes only in a job folder of the same path. */
  conversation: { choose: boolean; byFolder: boolean; transcript(session: string): string[] }
  login?: LoginSpec
  /** How the CLI lists the models of a login (harness/models.ts), and that answer in one shape (R5.7). */
  models?: { protocol: 'claude' | 'codex' | 'acp'; read(raw: any[]): ModelInfo[] }
  /** How it runs with a plan's key (R1.8); a harness with none cannot use a plan. */
  plan?: (o: PlanRun) => PlanSettings
  /** V11: the npm packages of its native binary, by folder name prefix, and which of them belong to the pin. */
  verify?: { platformPrefix: string; platformOk(name: string, version: string, pin: string): boolean }
}

/** A harness that runs with the user's own plan: a lab login, a model list and a check of its binary (V11). */
export type LabHarness = Harness & { name: HarnessName; login: LoginSpec; models: NonNullable<Harness['models']>; verify: NonNullable<Harness['verify']> }

/** The CLIs refresh their login this long before its access token ends. */
export const REFRESH_WINDOW_MS = 5 * 60_000
