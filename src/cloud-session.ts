export const CLOUD_SESSION_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type CloudSession = {
  userId: string;
  deviceId: string;
  deviceSecret: string;
  accessToken: string;
  accessTokenExpiresAt: string;
};

export function shouldRefreshCloudSession(
  session: CloudSession,
  nowMs = Date.now(),
): boolean {
  const expiresAt = Date.parse(session.accessTokenExpiresAt);
  return (
    !Number.isFinite(expiresAt) ||
    expiresAt - nowMs <= CLOUD_SESSION_REFRESH_WINDOW_MS
  );
}

export function serializeCloudSession(session: CloudSession): string {
  return JSON.stringify({
    userId: session.userId,
    deviceId: session.deviceId,
    deviceSecret: session.deviceSecret,
    accessToken: session.accessToken,
    accessTokenExpiresAt: session.accessTokenExpiresAt,
  } satisfies CloudSession);
}
