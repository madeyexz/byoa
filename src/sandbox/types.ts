// One interface for every sandbox provider (R5.3): create (with volumes mounted), resume, run a command, write a
// file, pause, destroy. An adapter for another provider (Daytona, Modal, ...) implements only this file's two interfaces;
// nothing else in byoa knows which provider runs the sandbox.

export interface Volume {
  /** The provider's volume name. byoa makes one per app, user and harness (the user's AI login, R1.4). */
  name: string
  /** Where it is mounted, relative to the sandbox user's home folder (such as `.claude`), because the home folder
   *  differs between providers. */
  path: string
}

export interface CreateOptions {
  /** Volumes to mount. The adapter creates a volume that does not exist yet. */
  volumes?: Volume[]
  /** Labels the provider keeps with the sandbox (E2B metadata, Daytona labels). Never secrets. */
  labels?: Record<string, string>
  /** The provider stops the sandbox after this long, even if byoa cannot (a crash, a lost network). */
  timeoutMs?: number
  /** A sandbox that byoa keeps between jobs (the user's sandbox, R5.4): when it times out, the provider pauses it and
   *  keeps its files, instead of deleting it. Without `keep`, the provider deletes it. */
  keep?: boolean
}

/** `resume` throws this when the provider no longer has the sandbox (it was deleted, or it expired). Other errors,
 *  such as a rate limit, are not this one: then the sandbox may still be there. */
export class SandboxGoneError extends Error {
  readonly code = 'gone'
}

export interface RunOptions {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** Each piece of output as it comes. */
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  /** Start the command and return at once; its output is not kept. */
  background?: boolean
}

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface Sandbox {
  readonly id: string
  /** The home folder of the user that commands run as, such as /home/user. */
  readonly home: string
  /** Runs a shell command (bash -c). A command that exits with a non-zero code resolves; it does not throw. */
  run(cmd: string, opts?: RunOptions): Promise<RunResult>
  /** Writes a file, with its parent folders. */
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  /** Reads a file through the provider's file API, or null when it is not there. Optional: without it, byoa reads a
   *  file as base64 on a command's stdout, a channel that a provider may keep in its command history. byoa reads the
   *  user's login files (R1.4) and a conversation's transcript (R5.9) with it. */
  readFile?(path: string): Promise<Uint8Array | null>
  /** Stops the sandbox at the provider and keeps its files and volumes; `resume` starts it again. Processes that run
   *  in it may stop (E2B pauses with no memory where it can; Daytona stops the sandbox). */
  pause(): Promise<void>
  /** Ends the sandbox at the provider. Its volumes stay. */
  destroy(): Promise<void>
}

/** What a provider can do, beyond the methods every provider has. */
export interface Capabilities {
  /** It mounts volumes (cliLogin, R1.5). False: `create` refuses a volume. */
  volumes: boolean
}

export interface SandboxProvider {
  readonly name: string
  /** Optional: a provider that does not say is taken to have volumes. createAgents refuses cliLogin on one without. */
  readonly capabilities?: Capabilities
  create(opts?: CreateOptions): Promise<Sandbox>
  /** Connects to a sandbox by its id, and starts it again when it is paused. `timeoutMs`: the provider stops it after
   *  this long (as in CreateOptions). Throws SandboxGoneError if the provider no longer has it. */
  resume(id: string, opts?: { timeoutMs?: number }): Promise<Sandbox>
  /** Ends a sandbox by its id, running or paused, such as a user's sandbox when the app deletes the user. Nothing
   *  happens when the provider no longer has it. */
  destroy(id: string): Promise<void>
  /** Deletes a volume and its files, when the app deletes a user. */
  deleteVolume(name: string): Promise<void>
  /** A sandbox that is not kept: the provider ends it `ms` from now, sooner or later than before; each call sets the
   *  time again. byoa uses it for the sign-in sandbox, which lives only while the app checks in (R1.7). Optional: a
   *  provider that cannot change a sandbox's time keeps the time it was created with. */
  keepAlive?(id: string, ms: number): Promise<void>
}
