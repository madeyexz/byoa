export { createAgents, LoginError, ProxyError, UsageLimitError, type UsageLimit, type Agents, type AgentsOptions, type Job, type RunOptions, type RunHarness, type ConnectResult, type Session, type SessionOptions, type JobToken, type ModelChoice, type Waiting } from './agents.ts'
export type { ModelInfo } from './harness/models.ts'
export { memoryStore, type Store, type Entry } from './store.ts'
export { SandboxGoneError, type Capabilities, type Sandbox, type SandboxProvider, type CreateOptions, type RunOptions as SandboxRunOptions, type RunResult, type Volume } from './sandbox/types.ts'
export { readPlugin, JOB_TOKEN_ENV, type Setup, type Skill, type Plugin, type Access } from './config.ts'
export type { AppTool, AppTools } from './mcp/tools.ts'
export type { AgentEvent, ErrorCode, Usage } from './harness/events.ts'
export { PINS, type Pins, type HarnessName } from './harness/pins.ts'
export { storedLogin, type StoredLoginOptions } from './login-stored.ts'
export { cliLogin, type LoginDriver, type LoginDeps, type LoginState, type LoginStart, type LoginResult } from './login.ts'
export { PLANS, type PlanName, type PlanState } from './plan.ts'
export { clientMetadataDocument, type OAuthConfig } from './mcp/oauth.ts'

// Deprecated: byoa's own tests and scripts use these, from src/ directly. An app has no use for them, and they change
// with the harnesses. They go away in 2.0.
import { ensureHarness as _ensureHarness, harnessFiles as _harnessFiles } from './harness/index.ts'
import { PACKAGES as _PACKAGES } from './harness/pins.ts'
import { LOGIN_FILES as _LOGIN_FILES } from './login-stored.ts'
/** @deprecated Internal: the files byoa writes for a harness. Removed in 2.0. */
export const harnessFiles = _harnessFiles
/** @deprecated Internal: installs the pinned harness (V11). Removed in 2.0. */
export const ensureHarness = _ensureHarness
/** @deprecated Internal: the npm package of each harness. Removed in 2.0. */
export const PACKAGES = _PACKAGES
/** @deprecated Internal: the CLI's login files of each harness. Removed in 2.0. */
export const LOGIN_FILES = _LOGIN_FILES
