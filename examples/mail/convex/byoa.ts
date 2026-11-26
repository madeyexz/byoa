// byoa's store (R6): four internal functions on the `byoa` table.
import { convexFunctions } from '@madeyexz/byoa/store/convex'

export const { get, put, remove, cas } = convexFunctions()
