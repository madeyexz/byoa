/** One shell word, quoted for bash. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
