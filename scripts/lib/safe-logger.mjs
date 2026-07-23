const ALLOWED_KEYS = new Set([
  "event",
  "phase",
  "threadId",
  "turnId",
  "successorThreadId",
  "rolloverId",
  "handoffHash",
  "watcherDescriptorHash",
  "errorCategory",
  "observedAt",
]);

export function createSafeLogger(writeLine = () => {}) {
  return {
    write(record) {
      const safeRecord = {};
      for (const [key, value] of Object.entries(record ?? {})) {
        if (ALLOWED_KEYS.has(key)) {
          safeRecord[key] = value;
        }
      }
      writeLine(JSON.stringify(safeRecord));
    },
  };
}
