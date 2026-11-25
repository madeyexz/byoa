// Reads files from a sandbox: with the provider's file API when it has one (Sandbox.readFile), else as base64 on a
// command's stdout.
import { q } from '../sh.ts'
import type { Sandbox } from './types.ts'

const dec = new TextDecoder()
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/** The files of `paths` (relative to `dir`) that are there and not empty, by path. */
export async function readFiles(sbx: Sandbox, dir: string, paths: string[]): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {}
  if (!paths.length) return files
  if (sbx.readFile) {
    for (const p of paths) {
      const b = await sbx.readFile(`${dir}/${p}`)
      if (b?.length) files[p] = b
    }
    return files
  }
  const r = await sbx.run(`cd ${q(dir)} && for f in ${paths.map(q).join(' ')}; do [ -s "$f" ] && printf '%s\\t%s\\n' "$f" "$(base64 < "$f" | tr -d '\\n')"; done; true`)
  for (const l of r.stdout.split('\n')) { const [p, b] = l.split('\t'); if (p && b) files[p] = fromB64(b) }
  return files
}

export const asText = (files: Record<string, Uint8Array>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([p, b]) => [p, dec.decode(b)]))
