// Deliberate public surface for embedding the headless runtime.
export { ConversationRuntime, type ConversationRuntimeOptions } from "./conversation/runtime.js";
export { SqliteConversationRepository } from "./conversation/sqlite-repository.js";
export { openStateDatabase, type StateConnection } from "./state/connection.js";
export { SessionRepository } from "./state/session-repository.js";
export type {
  ConversationRepository,
  ConversationRuntimeEvent,
  ConversationTurnResult,
  ModelRequest,
  ModelTransport,
  ToolDispatcher,
} from "./conversation/types.js";
export type { NormalizedResponse, SystemBands } from "./transports/types.js";
