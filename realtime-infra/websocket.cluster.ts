/**
 * WebSocket Cluster Manager — distributed node registry and connection tracking.
 *
 * Architecture (PM2 cluster / Kubernetes pod mesh):
 *
 *   Each worker process registers itself in Redis on startup with a TTL heartbeat.
 *   Workers refresh their heartbeat every HEARTBEAT_INTERVAL_MS.
 *   A node is considered dead when its TTL expires (heartbeat missed × 2).
 *
 *   User → Node routing:
 *     When a user connects, the node writes to igfx:cluster:user:{userId} → nodeId
 *     with the session TTL so admin tooling can locate which node serves a user.
 *     Cleared on disconnect or when the node shuts down.
 *
 *   Cluster-wide connection count:
 *     Each node publishes its local connection count to igfx:cluster:conns:{nodeId}.
 *     getClusterStats() reads all known nodes' connection counts from Redis.
 *
 *   Graceful drain:
 *     On SIGTERM/PM2 shutdown, deregister() clears the node's presence key so
 *     load-balancers stop routing new connections to it immediately.
 */

import { getRedis }   from "../shared/redis.js";
import { WORKER_ID }  from "./redis.pubsub.js";

// ── Redis key schema ──────────────────────────────────────────────────────────
const KEY_NODE       = (id: string) => `igfx:cluster:node:${id}`;         // node presence + metadata
const KEY_USER_NODE  = (uid: string) => `igfx:cluster:user:${uid}`;       // user → nodeId
const KEY_CONNS      = (id: string) => `igfx:cluster:conns:${id}`;        // per-node connection count
const SCAN_PREFIX    = "igfx:cluster:node:";

// ── Timing constants ─────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 10_000;   // refresh every 10 s
const NODE_TTL_SECONDS      = 25;       // node considered dead after 25 s without heartbeat
const USER_SESSION_SECONDS  = 3_600;    // user→node mapping lives 1 hour max

// ── Types ────────────────────────────────────────────────────────────────────
export type ClusterNodeInfo = {
  nodeId:      string;
  hostname:    string;
  pid:         number;
  startedAt:   string;
  connections: number;
};

export type ClusterStats = {
  nodes:            ClusterNodeInfo[];
  totalConnections: number;
  totalNodes:       number;
  generatedAt:      string;
};

// ─────────────────────────────────────────────────────────────────────────────

class WsClusterManager {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private localConnections = 0;

  readonly nodeId: string = WORKER_ID;

  /** Register this node in Redis and start the heartbeat. */
  async register(): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    const meta: Omit<ClusterNodeInfo, "connections"> = {
      nodeId:    this.nodeId,
      hostname:  process.env.HOSTNAME ?? "localhost",
      pid:       process.pid,
      startedAt: new Date().toISOString(),
    };

    await redis.setex(KEY_NODE(this.nodeId), NODE_TTL_SECONDS, JSON.stringify(meta));
    await redis.setex(KEY_CONNS(this.nodeId), NODE_TTL_SECONDS, "0");

    this.heartbeatTimer = setInterval(() => void this._heartbeat(), HEARTBEAT_INTERVAL_MS);
    console.log(`[ws-cluster] node=${this.nodeId} registered in Redis cluster`);
  }

  /** Remove this node from the cluster registry (call on graceful shutdown). */
  async deregister(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const redis = getRedis();
    if (!redis) return;
    await Promise.allSettled([
      redis.del(KEY_NODE(this.nodeId)),
      redis.del(KEY_CONNS(this.nodeId)),
    ]);
    console.log(`[ws-cluster] node=${this.nodeId} deregistered from Redis cluster`);
  }

  /** Track when a user connects to THIS node. */
  async onUserConnect(userId: string): Promise<void> {
    this.localConnections++;
    await this._publishConns();
    const redis = getRedis();
    if (redis) {
      await redis.setex(KEY_USER_NODE(userId), USER_SESSION_SECONDS, this.nodeId).catch(() => {});
    }
  }

  /** Track when a user disconnects from THIS node. */
  async onUserDisconnect(userId: string | undefined): Promise<void> {
    this.localConnections = Math.max(0, this.localConnections - 1);
    await this._publishConns();
    if (userId) {
      const redis = getRedis();
      if (redis) {
        // Only clear if this node still owns the mapping (prevent race with reconnect)
        const ownerNode = await redis.get(KEY_USER_NODE(userId)).catch(() => null);
        if (ownerNode === this.nodeId) {
          await redis.del(KEY_USER_NODE(userId)).catch(() => {});
        }
      }
    }
  }

  /** Track an anonymous (unauthenticated) connection. */
  onAnonConnect(): void {
    this.localConnections++;
    void this._publishConns();
  }

  onAnonDisconnect(): void {
    this.localConnections = Math.max(0, this.localConnections - 1);
    void this._publishConns();
  }

  /** Return the nodeId that currently holds a user's WebSocket session. */
  async findUserNode(userId: string): Promise<string | null> {
    const redis = getRedis();
    if (!redis) return null;
    return redis.get(KEY_USER_NODE(userId)).catch(() => null);
  }

  /** Return cluster-wide stats by scanning Redis for all live nodes. */
  async getClusterStats(): Promise<ClusterStats> {
    const redis = getRedis();
    if (!redis) {
      return {
        nodes:            [],
        totalConnections: this.localConnections,
        totalNodes:       1,
        generatedAt:      new Date().toISOString(),
      };
    }

    const nodeKeys = await this._scanNodeKeys(redis);
    if (!nodeKeys.length) {
      return {
        nodes: [], totalConnections: this.localConnections,
        totalNodes: 1, generatedAt: new Date().toISOString(),
      };
    }

    // Batch: fetch all node-metadata and all conn-count keys in 2 mget calls
    // instead of 2 individual GETs per node (eliminates N*2 round-trips → 2).
    const [metaRaws, connsRaws] = await Promise.all([
      redis.mget(...nodeKeys).catch(() => nodeKeys.map(() => null)),
      redis.mget(...nodeKeys.map((k) => {
        // nodeKey pattern is igfx:cluster:node:{id} → derive conns key
        const nodeId = k.replace("igfx:cluster:node:", "");
        return KEY_CONNS(nodeId);
      })).catch(() => nodeKeys.map(() => null)),
    ]);

    const nodes: ClusterNodeInfo[] = [];
    for (let i = 0; i < nodeKeys.length; i++) {
      try {
        const raw = metaRaws[i];
        if (!raw) continue;
        const meta = JSON.parse(raw) as Omit<ClusterNodeInfo, "connections">;
        nodes.push({ ...meta, connections: parseInt(connsRaws[i] ?? "0", 10) });
      } catch { /* stale key race */ }
    }

    const totalConnections = nodes.reduce((sum, n) => sum + n.connections, 0);

    return {
      nodes:            nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      totalConnections: totalConnections || this.localConnections,
      totalNodes:       nodes.length || 1,
      generatedAt:      new Date().toISOString(),
    };
  }

  /** Local connection count for this node only. */
  getLocalConnectionCount(): number {
    return this.localConnections;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private async _heartbeat(): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.expire(KEY_NODE(this.nodeId), NODE_TTL_SECONDS);
      await redis.expire(KEY_CONNS(this.nodeId), NODE_TTL_SECONDS);
    } catch { /* Redis blip — will retry next interval */ }
  }

  private async _publishConns(): Promise<void> {
    const redis = getRedis();
    if (!redis) return;
    try {
      await redis.setex(KEY_CONNS(this.nodeId), NODE_TTL_SECONDS, String(this.localConnections));
    } catch { /* non-fatal */ }
  }

  /** Scan all node presence keys with SCAN (non-blocking). */
  private async _scanNodeKeys(redis: ReturnType<typeof getRedis> & object): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, batch] = await (redis as import("ioredis").Redis).scan(
        cursor, "MATCH", `${SCAN_PREFIX}*`, "COUNT", "100",
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0");
    return keys;
  }
}

export const wsCluster = new WsClusterManager();
export default wsCluster;
