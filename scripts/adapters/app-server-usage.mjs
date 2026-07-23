import { createContextSnapshot } from "../domain/context-snapshot.mjs";
import { RolloverError } from "../lib/errors.mjs";

export const TOKEN_USAGE_NOTIFICATION = "thread/tokenUsage/updated";

export function fromAppServerNotification(notification, { observedAt } = {}) {
  if (
    notification === null ||
    typeof notification !== "object" ||
    notification.method !== TOKEN_USAGE_NOTIFICATION
  ) {
    throw new RolloverError("unsupported_app_server_notification");
  }

  const params = notification.params;
  const tokenUsage = params?.tokenUsage;
  try {
    return createContextSnapshot({
      threadId: params?.threadId,
      turnId: params?.turnId,
      activeContextTokens: tokenUsage?.last?.totalTokens,
      accumulatedSessionTokens: tokenUsage?.total?.totalTokens,
      modelContextWindow: tokenUsage?.modelContextWindow,
      observedAt: observedAt ?? new Date().toISOString(),
      source: "app-server",
    });
  } catch {
    throw new RolloverError("malformed_app_server_notification");
  }
}
