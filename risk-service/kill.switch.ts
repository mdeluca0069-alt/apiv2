import { prisma }       from "../shared/db.js";
import type { KillSwitchState } from "../shared/contracts.js";
import { alertManager } from "../alerting/alert.manager.js";
import { metrics }      from "../gateway/metrics.js";

const SETTING_KEY = "kill_switch";

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
  }

  async deactivate(deactivatedBy: string): Promise<void> {
    _cached = {
      active:  false,
      reason:  `Deactivated by ${deactivatedBy} at ${new Date().toISOString()}`,
    };
    await this._persist();
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
