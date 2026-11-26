import { cronJobs } from 'convex/server'
import { internal } from './_generated/api.js'

const crons = cronJobs()
// sign-ins the page left, jobs whose action died, visitors to forget, and the line of jobs (demo.sweep)
crons.interval('sweep', { minutes: 1 }, internal.demo.sweep)
export default crons
