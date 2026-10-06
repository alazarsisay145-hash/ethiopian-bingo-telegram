type LogEvent = 'render-failed' | 'telegram-unavailable' | 'invalid-server-event' | 'connection-failed';

export const logger = {
  error(event: LogEvent, error?: unknown): void {
    const kind = error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : 'Unknown';
    // Never serialize errors, payloads, URLs, or Telegram launch data.
    console.error(`[bingo] ${event}`, { kind });
  },
};
