import { prisma }       from "../shared/db.js";
import type { KillSwitchState } from "../shared/contracts.js";
import { alertManager } from "../alerting/alert.manager.js";
import { metrics }      from "../gateway/metrics.js";
import { immutableAudit } from "../security/immutable.audit.js";
import { publishControlChannel, subscribeControlChannel } from "../shared/control.channel.js";

const SETTING_KEY = "kill_switch";
const CHANNEL      = "kill-switch";

// Hot in-process cache — avoids a DB hit on every pre-trade check
let _cached: KillSwitchState = { active: false, reason: "" };

export class KillSwitch {
  /** Load state from DB on startup / after admin change. */
  async load(): Promise<void> {
    try {
      const row = await prisma.brokerSetting.findUnique({ where: { key: SETTING_KEY } });
      if (row) _cached = row.value as KillSwitchState;
    } catch {
      // DB unavailable — keep previous state
    }
  }

  /**
   * Fix #6: subscribes to cross-worker kill-switch changes so that an
   * activate()/deactivate() on ANY worker (e.g. whichever one handled the
   * admin's HTTP request) is reflected on every other worker's in-process
   * cache within milliseconds, instead of only on the worker that made the
   * change — closing the gap where a PM2/Docker-replica deployment's other
   * workers kept accepting trades after an emergency stop.
   * Call once at startup, after load(). No-op (single-worker-safe) with no
   * Redis configured.
   */
  async startSync(): Promise<void> {
    await subscribeControlChannel(CHANNEL, (payload) => {
      _cached = payload as KillSwitchState;
      console.warn(`[kill-switch] state synced from another worker: active=${_cached.active} reason="${_cached.reason}"`);
    });
  }

  isActive(): boolean {
    return _cached.active;
  }

  getState(): KillSwitchState {
    return { ..._cached };
  }

  async activate(reason: string, activatedBy: string): Promise<void> {
    _cached = {
      active:       true,
      reason,
      activatedAt:  new Date().toISOString(),
      activatedBy,
    };
    await this._persist();
    metrics.inc("kill_switch_activations_total");
    void alertManager.killSwitchActivated(reason, activatedBy);
    void publishControlChannel(CHANNEL, _cached);
    // PHASE2_REMEDIATION (H16, admin audit-log gap): this is the single
    // most severe control in the platform -- it halts ALL trading
    // cluster-wide -- yet had zero record in the permanent, hash-chained
    // AuditLog. The BrokerSetting row above is overwritten on every state
    // change (no history) and alertManager's notification is transient,
    // not a queryable historical record. Mirrors the actor/action/entity/
    // payload shape already used throughout this codebase.
    await immutableAudit.write({
      actor:   activatedBy,
      action:  "kill_switch.activated",
      entity:  "platform",
      payload: { reason, activatedAt: _cached.activatedAt } as object,
    });
  }

  async deactivate(deactivatedBy: string): Promise<void> {
    _cached = {
      active:  false,
      reason:  `Deactivated by ${deactivatedBy} at ${new Date().toISOString()}`,
    };
    await this._persist();
    void publishControlChannel(CHANNEL, _cached);
    await immutableAudit.write({
      actor:   deactivatedBy,
      action:  "kill_switch.deactivated",
      entity:  "platform",
      payload: { reason: _cached.reason } as object,
    });
  }

  private async _persist(): Promise<void> {
    await prisma.brokerSetting.upsert({
      where:  { key: SETTING_KEY },
      create: { key: SETTING_KEY, value: _cached as object },
      update: { value: _cached as object },
    });
  }
}

export const killSwitch = new KillSwitch();
