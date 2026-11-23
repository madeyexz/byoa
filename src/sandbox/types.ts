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
  /** Stops the sandbox at the provider and keeps its files and volumes; `resume` starts it again. Processes that run
   *  in it may stop (E2B pauses with no memory where it can; Daytona stops the sandbox). */
  pause(): Promise<void>
  /** Ends the sandbox at the provider. Its volumes stay. */
  destroy(): Promise<void>
}

export interface SandboxProvider {
  readonly name: string
  create(opts?: CreateOptions): Promise<Sandbox>
  /** Connects to a sandbox by its id, and starts it again when it is paused. `timeoutMs`: the provider stops it after
   *  this long (as in CreateOptions). Throws SandboxGoneError if the provider no longer has it. */
  resume(id: string, opts?: { timeoutMs?: number }): Promise<Sandbox>
  /** Ends a sandbox by its id, running or paused, such as a user's sandbox when the app deletes the user. Nothing
   *  happens when the provider no longer has it. */
  destroy(id: string): Promise<void>
  /** Deletes a volume and its files, when the app deletes a user. */
  deleteVolume(name: string): Promise<void>
}
