// Every key that byoa writes in the app's store (R6), in one place: this list is what byoa keeps. A store cannot list
// its keys, so the indexes (`grants/`, `usersandboxes/`, `conversations/`) list a user's entries. Values marked sealed
// are encrypted with the app's key, with the key as associated data (crypto.ts); the others hold no secret.
// The strings must not change: they name data that apps already keep.
const enc = encodeURIComponent

export const keys = {
  // MCP (R2)
  /** sealed: one MCP grant of a user */
  grant: (user: string, name: string) => `grant/${enc(user)}/${name}`,
  /** the names and URLs of a user's grants */
  grants: (user: string) => `grants/${enc(user)}`,
  /** the lease of the one refresh of a grant (R2.3) */
  grantLease: (user: string, name: string) => `lease/${enc(user)}/${name}`,
  /** sealed: an MCP sign-in that has not come back yet */
  mcpFlow: (state: string) => `mcpflow/${state}`,
  /** a job token, by its hash (R3.1, R3.4) */
  jobToken: (hash: string) => `job/${hash}`,
  /** a job's token hash, by the job id */
  job: (job: string) => `jobid/${job}`,

  // AI login (R1)
  /** `signed-in`, `signed-out` or `expired` of a lab login (R1.6) */
  loginState: (user: string, h: string) => `login/${enc(user)}/${h}`,
  /** a sign-in that runs now: its sandbox */
  loginPending: (user: string, h: string) => `loginjob/${enc(user)}/${h}`,
  /** sealed: the CLI's own login files (R1.4) */
  login: (user: string, h: string) => `ailogin/${enc(user)}/${h}`,
  /** who holds the login now (R1.4) */
  loginLease: (user: string, h: string) => `ailoginlease/${enc(user)}/${h}`,
  /** the jobs that wait for the login, in order (R5.8) */
  loginLine: (user: string, h: string) => `ailoginline/${enc(user)}/${h}`,
  /** a sandbox that has the login now: the stored version it got */
  loginLoan: (user: string, h: string, sandbox: string) => `ailoginloan/${enc(user)}/${h}/${enc(sandbox)}`,
  /** sealed: the key of a plan (R1.8) */
  planKey: (user: string, plan: string) => `aikey/${enc(user)}/${plan}`,
  /** `signed-in`, `expired` or `no-plan` of a plan's key */
  planState: (user: string, plan: string) => `aikeystate/${enc(user)}/${plan}`,

  // Sandboxes (R5.4)
  /** a kept sandbox of a user: its id at the provider and the lease of the job that uses it */
  slot: (user: string, provider: string, h: string, key: string) => `usersandbox/${enc(user)}/${provider}/${h}/${enc(key)}`,
  /** the jobs that wait for a kept sandbox, in order (R5.8) */
  slotLine: (user: string, provider: string, h: string, key: string) => `usersandbox/${enc(user)}/${provider}/${h}/${enc(key)}/line`,
  /** the user's kept sandboxes at a provider: [harness, sandbox key] */
  slots: (user: string, provider: string) => `usersandboxes/${enc(user)}/${provider}`,

  // Conversations (R5.9)
  /** sealed: a conversation of one harness: the harness's own session id and its transcript */
  conversation: (user: string, h: string, id: string) => `conversation/${enc(user)}/${h}/${enc(id)}`,
  /** the user's conversations: [harness, conversation id] */
  conversations: (user: string) => `conversations/${enc(user)}`,
}
