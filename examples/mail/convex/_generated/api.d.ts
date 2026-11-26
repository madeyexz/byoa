/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents from "../agents.js";
import type * as byoa from "../byoa.js";
import type * as crons from "../crons.js";
import type * as demo from "../demo.js";
import type * as http from "../http.js";
import type * as lib from "../lib.js";
import type * as mail from "../mail.js";
import type * as sample from "../sample.js";
import type * as track from "../track.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  byoa: typeof byoa;
  crons: typeof crons;
  demo: typeof demo;
  http: typeof http;
  lib: typeof lib;
  mail: typeof mail;
  sample: typeof sample;
  track: typeof track;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
