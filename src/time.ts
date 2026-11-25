// Time for byoa's leases, lines and job tokens. Each lease compares a time that one backend wrote with another
// backend's clock, so they all read it here; a test moves `clock.now` to make a lease run out at once. Internal.
export const clock = { now: () => Date.now() }
export const now = () => clock.now()
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
