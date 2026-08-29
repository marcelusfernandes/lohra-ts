export interface ChatDelta {
  sessionId: string;
  delta: string;
}

export type ChatEvents = {
  delta: ChatDelta;
};
