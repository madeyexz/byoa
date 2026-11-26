// Usage events to PostHog, when the deployment has POSTHOG_KEY (a project's public key, which only sends events). The
// visitor id is a secret, so PostHog gets a hash of it.
import { v } from 'convex/values'
import { internalAction } from './_generated/server.js'

export const send = internalAction({
  args: { visitor: v.string(), event: v.string(), properties: v.any() },
  handler: async (_ctx, a) => {
    const key = process.env.POSTHOG_KEY
    if (!key) return
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(a.visitor)))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
    await fetch(`${process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com'}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: key, event: a.event, distinct_id: hash, properties: { app: 'byoa-mail-demo', $process_person_profile: false, ...a.properties } }),
    }).catch(() => {})
  },
})
