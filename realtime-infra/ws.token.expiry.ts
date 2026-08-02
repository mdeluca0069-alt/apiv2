/**
 * PHASE C PENTEST (JWT/session finding #3): verifyClient() (main.ts)
 * validates the JWT once, at WS handshake, but previously nothing
 * thereafter re-checked token validity for the life of the connection --
 * a socket opened with a soon-to-expire access token kept its
 * userId/tenantId trusted (used to route pushToUser/pushToStaff) past
 * the JWT's own `exp`. main.ts's 30s keepalive loop now calls
 * isTokenExpired() on every tick and closes the socket once the
 * authenticating token's exp has passed, bounding a stale connection's
 * lifetime to the token's own remaining validity.
 *
 * Extracted as its own pure function (main.ts is a top-level bootstrap
 * script with side-effecting module-load code and is never imported by
 * the test suite -- same reasoning as realtime-infra/ws.sequence.ts's
 * H8 fix) so this specific check has independent test coverage.
 */
export function isTokenExpired(exp: number | undefined, nowMs: number): boolean {
  if (!exp) return false;
  return nowMs >= exp * 1000;
}
