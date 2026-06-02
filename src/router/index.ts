/**
 * Router barrel — the plumbing that maps Slack threads to coding-agent turns.
 * The router is NOT an LLM: no model calls, no intent
 * detection. See router.ts for the glue and dispatcher.ts for the turn
 * lifecycle.
 */
export { Dispatcher, type DispatcherDeps, formatPrompt } from "./dispatcher.js";
export { Router, type RouterOptions, type TurnDispatcher } from "./router.js";
