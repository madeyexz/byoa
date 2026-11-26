// byoa for the hosted demo: one `agents` object for each action or HTTP action, with byoa's state in this deployment
// (convexStore) and the mail tools on the visitor's copy of the sample inbox (mail.ts). The Node actions (agents.ts)
// give it the Instabox sandbox; byoa's proxy (http.ts) needs no sandbox.
import { createAgents, type Agents, type RunHarness, type SandboxProvider } from '@madeyexz/byoa'
import { convexStore } from '@madeyexz/byoa/store/convex'
import { internal } from './_generated/api.js'
import type { ActionCtx } from './_generated/server.js'
import { AGENTS_MD, TOOLS } from '../triage.ts'
import { JOB_MS } from './demo.ts'
import { SENT } from './sample.ts'

export function agentsFor(ctx: Pick<ActionCtx, 'runQuery' | 'runMutation'>, sandbox: SandboxProvider): Agents {
  const site = process.env.CONVEX_SITE_URL!
  const key = process.env.BYOA_KEY
  if (!key) throw new Error('Set BYOA_KEY on the deployment: 32 random bytes as base64')
  return createAgents({
    app: 'mail-demo',
    sandbox,
    store: convexStore(ctx, internal.byoa),
    encryptionKey: key,
    proxyUrl: `${site}/byoa/mcp`,
    oauth: { redirectUrl: `${site}/byoa/callback`, clientName: 'byoa mail demo' },
    jobTimeoutMs: JOB_MS,
    // one job of a visitor at a time (demo.startJob), so a job never waits long for the visitor's sandbox
    waitMs: 60_000,
    tools: {
      mail: {
        list_inbox: { ...TOOLS.list_inbox, run: (_a, { user }): Promise<unknown> => ctx.runQuery(internal.mail.inbox, { visitor: user }) },
        read_message: { ...TOOLS.read_message, run: (a, { user }): Promise<unknown> => ctx.runQuery(internal.mail.message, { visitor: user, id: String(a.id) }) },
        label_message: {
          ...TOOLS.label_message,
          run: (a, { user }): Promise<unknown> => ctx.runMutation(internal.mail.label, { visitor: user, id: String(a.id), category: String(a.category), reason: String(a.reason ?? ''), code: a.code ? String(a.code) : undefined }),
        },
        my_sent_mail: { ...TOOLS.my_sent_mail, run: async () => SENT },
        save_draft: { ...TOOLS.save_draft, run: (a, { user }): Promise<unknown> => ctx.runMutation(internal.mail.draft, { visitor: user, id: String(a.id), body: String(a.body ?? '') }) },
      },
    },
  })
}

/** One triage job: the app's own task, the mail tools only, and no file changes or network (R5.6). */
export function triage(agents: Agents, visitor: string, harness: RunHarness, task = 'Triage my inbox.') {
  return agents.run(visitor, { harness, task, mcp: ['mail'], access: 'read-only', setup: { agentsMd: AGENTS_MD } })
}
