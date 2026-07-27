/**
 * jwt.key.manager.cluster.sync.spec.ts
 *
 * PRODUCTION CUTOVER Stage 3B — critical finding: JwtKeyManager.rotate() was
 * purely in-process. scheduleAutoRotation(24h) runs independently on every
 * api replica with no coordination, and generateHs256Slot()/
 * generateRs256Slot() are genuinely random (crypto.randomBytes /
 * generateKeyPairSync) -- so 24 hours after a multi-replica boot, every
 * replica would rotate to a DIFFERENT signing key with no shared source of
 * truth. A token signed by replica A would fail verification the instant
 * nginx's round-robin sent the next request to replica B or C -- exactly
 * the multi-replica topology this Stage's own load testing proved is
 * required for production (SHADOW_PRODUCTION_REPORT.md §5).
 *
 * Fix: rotate() now broadcasts the winning key over the same Redis
 * control-channel already used for kill-switch/risk-supervisor/broker-
 * spread cluster sync; every replica subscribes via startClusterSync() and
 * converges on whichever rotation it receives, instead of generating its
 * own independently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let capturedHandler: ((payload: unknown) => void) | null = null;
const mockPublish = vi.fn().mockResolvedValue(undefined);

vi.mock("../shared/control.channel.js", () => ({
  publishControlChannel: mockPublish,
  subscribeControlChannel: vi.fn(async (_name: string, handler: (payload: unknown) => void) => {
    capturedHandler = handler;
  }),
}));

const { jwtKeyManager } = await import("../security/jwt-key-manager.js");

beforeEach(() => {
  vi.clearAllMocks();
  capturedHandler = null;
  process.env.JWT_SECRET = "a".repeat(64);
  delete process.env.JWT_PRIVATE_KEY;
  delete process.env.JWT_PUBLIC_KEY;
  jwtKeyManager.init();
});

describe("JwtKeyManager cluster sync", () => {
  it("broadcasts the new primary key over the control channel when this replica rotates", () => {
    const before = jwtKeyManager.getPrimarySlot();
    jwtKeyManager.rotate();
    const after = jwtKeyManager.getPrimarySlot();

    expect(after.kid).not.toBe(before.kid);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [channel, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe("jwt-key-rotation");
    expect(payload.kid).toBe(after.kid);
    expect(payload.signingKey).toBe(after.signingKey);
  });

  it("a token signed BEFORE a remote rotation still verifies AFTER converging to it (grace window)", async () => {
    const token = jwtKeyManager.createToken({ sub: "u1", email: "u1@x.com", tenantId: "t1", roles: ["trader"], permissions: [] });

    await jwtKeyManager.startClusterSync();
    expect(capturedHandler).not.toBeNull();

    // Simulate a rotation broadcast arriving from a DIFFERENT replica --
    // without the fix, this replica would never hear about it and would
    // independently rotate to its own unrelated key on its own timer.
    capturedHandler!({
      kid: "remote-kid-1234567890ab",
      signingKey: "b".repeat(64),
      verifyKey: "b".repeat(64),
      algorithm: "HS256",
      createdAt: Date.now(),
    });

    expect(jwtKeyManager.getPrimarySlot().kid).toBe("remote-kid-1234567890ab");
    // The old key is now the secondary (grace window) -- the token signed
    // moments ago by THIS replica, before it heard about the remote
    // rotation, must still verify.
    expect(jwtKeyManager.verifyToken(token)).not.toBeNull();
  });

  it("a token signed by the OTHER replica (using its new key) verifies here too, once converged", async () => {
    await jwtKeyManager.startClusterSync();

    const remoteKid = "remote-kid-1234567890ab";
    const remoteSecret = "c".repeat(64);
    capturedHandler!({
      kid: remoteKid, signingKey: remoteSecret, verifyKey: remoteSecret,
      algorithm: "HS256", createdAt: Date.now(),
    });

    // A token minted by the remote replica AFTER its own rotation, using
    // the now-shared key -- proves cross-replica verification actually works,
    // not just that local state didn't crash.
    expect(jwtKeyManager.getPrimarySlot().kid).toBe(remoteKid);
    const tokenFromOtherReplica = jwtKeyManager.createToken({ sub: "u2", email: "u2@x.com", tenantId: "t1", roles: ["trader"], permissions: [] });
    expect(jwtKeyManager.verifyToken(tokenFromOtherReplica)).not.toBeNull();
  });

  it("ignores an echo of its own rotation (same kid) without disturbing state", async () => {
    await jwtKeyManager.startClusterSync();
    jwtKeyManager.rotate();
    const afterLocalRotate = jwtKeyManager.getPrimarySlot();

    const [, payload] = mockPublish.mock.calls[0] as [string, Record<string, unknown>];
    capturedHandler!(payload); // Redis echoing our own publish back to us

    expect(jwtKeyManager.getPrimarySlot().kid).toBe(afterLocalRotate.kid);
  });

  it("ignores a malformed broadcast instead of throwing", async () => {
    await jwtKeyManager.startClusterSync();
    const before = jwtKeyManager.getPrimarySlot();

    expect(() => capturedHandler!({ garbage: true })).not.toThrow();
    expect(() => capturedHandler!(null)).not.toThrow();

    expect(jwtKeyManager.getPrimarySlot().kid).toBe(before.kid);
  });
});
