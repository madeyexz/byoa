// One interface for every sandbox provider (R5.3): create (with volumes mounted), resume, run a command, write a
// file, destroy. An adapter for another provider (Daytona, Modal, ...) implements only this file's two interfaces;
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
  /** The provider ends the sandbox after this long, even if byoa cannot (a crash, a lost network). */
  timeoutMs?: number
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
  /** Ends the sandbox at the provider. Its volumes stay. */
  destroy(): Promise<void>
}

export interface SandboxProvider {
  readonly name: string
  create(opts?: CreateOptions): Promise<Sandbox>
  /** Connects to a sandbox that still runs, by its id. Throws if the provider no longer has it. */
  resume(id: string): Promise<Sandbox>
  /** Deletes a volume and its files, when the app deletes a user. */
  deleteVolume(name: string): Promise<void>
}
