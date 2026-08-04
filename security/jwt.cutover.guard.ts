/**
 * security/jwt.cutover.guard.ts — explicit JWT cutover-safety mode.
 *
 * CUTOVER REMEDIATION (Task 2). tests/jwt.v1.compat.spec.ts already proved
 * BOTH halves of this requirement: a v1-issued HS256 token verifies
 * correctly against jwt-key-manager.ts when apiv2 is configured with the
 * matching JWT_SECRET (no JWT_PRIVATE_KEY/JWT_PUBLIC_KEY set), and that
 * same token instantly stops verifying the moment real RSA key material is
 * present, because jwt-key-manager.ts's init() unconditionally prefers
 * RS256 whenever JWT_PRIVATE_KEY/JWT_PUBLIC_KEY both look like real PEM
 * (see its own `useRSA` check). That proved the DANGER is real; nothing
 * previously PREVENTED it -- a cutover-window deployment could still be
 * misconfigured into RS256 mode with no error, silently forcing every
 * currently-logged-in v1 user to re-login the instant it went live.
 *
 * This module is the enforcement: set JWT_CUTOVER_MODE=true for the
 * duration of the migration window (T-60m through the end of the soak
 * period in CUTOVER_PLAYBOOK.md) and the application refuses to start at
 * all if its JWT configuration would break legacy v1 token compatibility.
 * Once the soak period passes and Stage 5 (legacy retirement) is
 * approved, unset JWT_CUTOVER_MODE (or set it to "false") to lift the
 * restriction -- RS256/key rotation are perfectly fine once v1 tokens no
 * longer need to be honored.
 *
 * Pure, side-effect-free, and independently testable (main.ts's own
 * startup-validation IIFE cannot be imported directly -- it runs
 * unconditionally at module load and starts a live server -- so the
 * actual decision logic lives here and main.ts just calls it).
 */

import { createHash } from "node:crypto";

export type JwtCutoverCheckEnv = {
  JWT_CUTOVER_MODE?:           string;
  JWT_PRIVATE_KEY?:            string;
  JWT_PUBLIC_KEY?:             string;
  JWT_SECRET?:                 string;
  JWT_SECRET_V1_FINGERPRINT?:  string;
};

export type JwtCutoverCheckResult =
  | { ok: true; cutoverModeActive: boolean }
  | { ok: false; error: string };

/**
 * SHA-256 fingerprint of a JWT_SECRET value, for out-of-band comparison
 * against v1's real secret without either secret ever appearing in a log
 * line, error message, or this function's return value. The deploying
 * engineer computes this once from v1's actual JWT_SECRET (e.g.
 * `node -e "console.log(require('crypto').createHash('sha256').update(process.env.JWT_SECRET).digest('hex'))"`
 * run against v1's real environment) and sets it as
 * JWT_SECRET_V1_FINGERPRINT in apiv2's environment; this function then
 * verifies apiv2's own configured JWT_SECRET hashes to the same value.
 */
export function fingerprintJwtSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * Returns ok:false (with a human-actionable error) if JWT_CUTOVER_MODE is
 * active and the current JWT configuration would break v1 token
 * compatibility. Returns ok:true (cutoverModeActive:false) when the flag
 * isn't set at all -- normal, non-cutover operation is completely
 * unaffected by this module's existence.
 */
export function checkJwtCutoverConfig(env: JwtCutoverCheckEnv): JwtCutoverCheckResult {
  const cutoverModeActive = env.JWT_CUTOVER_MODE === "true";
  if (!cutoverModeActive) return { ok: true, cutoverModeActive: false };

  const hasRSA =
    Boolean(env.JWT_PRIVATE_KEY?.includes("BEGIN")) &&
    Boolean(env.JWT_PUBLIC_KEY?.includes("BEGIN"));

  if (hasRSA) {
    return {
      ok: false,
      error:
        "JWT_CUTOVER_MODE=true requires HS256 for legacy v1 token compatibility, but " +
        "JWT_PRIVATE_KEY/JWT_PUBLIC_KEY are both set -- jwt-key-manager.ts always prefers " +
        "RS256 when real RSA key material is present, which would make every v1-issued " +
        "session token instantly unverifiable the moment this deploys, forcing every " +
        "currently-logged-in user to re-login. Unset JWT_PRIVATE_KEY and JWT_PUBLIC_KEY " +
        "for the duration of the cutover window, or set JWT_CUTOVER_MODE=false once the " +
        "soak period has passed and legacy token compatibility is no longer required.",
    };
  }

  const secret = env.JWT_SECRET ?? "";
  if (secret.length < 32) {
    return {
      ok: false,
      error:
        "JWT_CUTOVER_MODE=true requires JWT_SECRET to be set (>=32 chars) and to match v1's " +
        "exact HS256 signing secret, so existing v1 sessions remain valid through cutover. " +
        "JWT_SECRET is currently missing or too short.",
    };
  }

  const expectedFingerprint = env.JWT_SECRET_V1_FINGERPRINT;
  if (expectedFingerprint) {
    const actualFingerprint = fingerprintJwtSecret(secret);
    if (actualFingerprint !== expectedFingerprint) {
      return {
        ok: false,
        error:
          "JWT_CUTOVER_MODE=true and JWT_SECRET_V1_FINGERPRINT are both set, but the " +
          "configured JWT_SECRET does not hash to the expected fingerprint -- this means " +
          "apiv2's JWT_SECRET does NOT match v1's real signing secret, so v1-issued tokens " +
          "will fail verification even though HS256 mode is otherwise correctly configured. " +
          "Neither secret is included in this error; recompute JWT_SECRET_V1_FINGERPRINT " +
          "from v1's actual JWT_SECRET and confirm apiv2's JWT_SECRET was copied correctly.",
      };
    }
  }

  return { ok: true, cutoverModeActive: true };
}
