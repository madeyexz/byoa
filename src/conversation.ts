// Conversations (R5.9): a job of a conversation continues the harness's own session of the jobs before it. byoa keeps,
// for each user, harness and conversation id, the harness's session id and a copy of its transcript (the CLI's own
// session files), encrypted in the store. The session lives in the conversation's kept sandbox; when the provider lost
// that sandbox, the next job writes the stored transcript into its new one, so the conversation goes on. A transcript
// larger than `maxBytes` is not stored: then a lost sandbox loses the conversation, and the next job says so and
// starts it again.
import { open, seal } from './crypto.ts'
import type { Harness, Turn } from './harness/types.ts'
import { keys } from './keys.ts'
import { readFiles } from './sandbox/read.ts'
import type { Sandbox } from './sandbox/types.ts'
import { q } from './sh.ts'
import { update, type Store } from './store.ts'
import { now } from './time.ts'

interface Record {
  /** The harness's own session id. */
  session: string
  /** Jobs that this session has had. */
  turns: number
  /** The job folder the session ran in: a harness keeps its sessions by their working folder. */
  work: string
  /** The session's files, relative to the harness's home folder, as base64; none when they were too large. */
  transcript?: { [path: string]: string }
  at: number
}
type Indexed = [string, string]

const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s) }
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** The conversation's session files in the sandbox, relative to the harness's home folder. */
async function find(sbx: Sandbox, home: string, x: Harness, session: string): Promise<string[]> {
  const paths = x.conversation.transcript(session).map((p) => `-path ${q(`./${p}`)}`).join(' -o ')
  const r = await sbx.run(`cd ${q(home)} 2>/dev/null && find . -type f \\( ${paths} \\) 2>/dev/null; true`)
  return r.stdout.split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, ''))
}

export function conversations(store: Store, key: Promise<CryptoKey>, o: { maxBytes: number }) {
  const get = async (user: string, h: string, id: string): Promise<Record | undefined> => {
    const k = keys.conversation(user, h, id)
    const e = await store.get(k)
    return e ? JSON.parse(await open(await key, e.value, k)) as Record : undefined
  }

  /** Adds conversations to the user's index, those that are not in it. */
  const index = (user: string, add: Indexed[]) => add.length ? update(store, keys.conversations(user), (v) => {
    const l: Indexed[] = v ? JSON.parse(v) : []
    const more = add.filter(([a, b]) => !l.some(([x, y]) => x === a && y === b))
    return more.length ? JSON.stringify([...l, ...more]) : undefined
  }) : undefined

  return {
    /** The turn this job takes: the session to resume, or a new one. `lost`: the conversation had a session, but
     *  neither the sandbox nor the store has its transcript. `home`: the harness's home folder in the sandbox. */
    async begin(user: string, x: Harness, id: string, sbx: Sandbox, home: string, work: string): Promise<{ turn: Turn; turns: number; lost: boolean }> {
      const rec = await get(user, x.name, id)
      const fresh: Turn = x.conversation.choose ? { session: crypto.randomUUID(), resume: false } : { resume: false }
      if (!rec) return { turn: fresh, turns: 0, lost: false }
      const resume = { turn: { session: rec.session, resume: true }, turns: rec.turns, lost: false }
      if ((await find(sbx, home, x, rec.session)).length) return resume
      // a new sandbox: the stored transcript, at the same place in the harness's home folder. A harness that keeps
      // sessions by the job folder's path finds it only when that path is the same (it is at one provider)
      if (rec.transcript && (!x.conversation.byFolder || rec.work === work) && Object.keys(rec.transcript).length) {
        for (const [p, data] of Object.entries(rec.transcript)) await sbx.writeFile(`${home}/${p}`, unb64(data))
        return resume
      }
      return { turn: fresh, turns: 0, lost: true }
    },

    /** After the harness ended: keeps its session id and transcript. Returns the session id, or undefined when the
     *  harness kept no session (it failed before it began one). */
    async finish(user: string, x: Harness, id: string, sbx: Sandbox, home: string, work: string, turn: Turn, turns: number, named?: string): Promise<string | undefined> {
      const session = named ?? turn.session
      if (!session) return undefined
      const found = await find(sbx, home, x, session)
      if (!found.length) return turn.resume ? session : undefined
      const files = await readFiles(sbx, home, found)
      const size = Object.values(files).reduce((n, b) => n + b.length, 0)
      const rec: Record = {
        session, turns: (turn.resume ? turns : 0) + 1, work, at: now(),
        ...(size <= o.maxBytes ? { transcript: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, b64(b)])) } : {}),
      }
      const k = keys.conversation(user, x.name, id)
      // in the index before the record, so a backend that dies cannot leave a record that no index lists; and again
      // after, in case a remove took it out of the index meanwhile (spec/tla/Index.tla)
      await index(user, [[x.name, id]])
      await store.put(k, await seal(await key, JSON.stringify(rec), k))
      await index(user, [[x.name, id]])
      return session
    },

    /** Deletes the user's conversations: all of them, or those of one id. Returns the ones it deleted. */
    async remove(user: string, id?: string): Promise<Indexed[]> {
      const e = await store.get(keys.conversations(user))
      const gone = (e ? JSON.parse(e.value) as Indexed[] : []).filter(([, c]) => id === undefined || c === id)
      for (const [h, c] of gone) await store.delete(keys.conversation(user, h, c))
      await update(store, keys.conversations(user), (v) => JSON.stringify((v ? JSON.parse(v) as Indexed[] : []).filter(([a, b]) => !gone.some(([x, y]) => x === a && y === b))))
      // a job of one of them that ended meanwhile wrote its record again: it goes back in the index, so the next remove
      // finds it
      const back: Indexed[] = []
      for (const [h, c] of gone) if (await store.get(keys.conversation(user, h, c))) back.push([h, c])
      await index(user, back)
      return gone
    },
  }
}

export type Conversations = ReturnType<typeof conversations>
