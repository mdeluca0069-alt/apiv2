/**
 * RegulatoryReporting — MiFID II Article 26 transaction reporting.
 *
 * In production: submit transaction reports to an ARM (Approved Reporting Mechanism).
 * This implementation stores reports in AuditLog and prepares the RTS 22 format.
 */
import { randomUUID } from "node:crypto";
import { IS_PERSISTENT } from "../shared/db.js";
import { immutableAudit } from "../security/immutable.audit.js";
import { mifidEngine } from "./mifid.engine.js";

export type RegulatoryReport = {
  reportId:      string;
  reportType:    "TRADE" | "POSITION" | "TRANSACTION";
  regulatoryRef: string;     // MiFID II Article 26 / RTS 22
  orderId?:      string;
  userId:        string;
  symbol:        string;
  quantity:      number;
  price:         number;
  side:          string;
  venue:         string;
  reportedAt:    string;
  status:        "PENDING" | "SUBMITTED" | "REJECTED";
};

export class RegulatoryReportingService {

  async reportTrade(params: {
    orderId:  string;
    userId:   string;
    symbol:   string;
    side:     string;
    quantity: number;
    price:    number;
  }): Promise<RegulatoryReport> {
    await mifidEngine.reportTrade(params);

    const report: RegulatoryReport = {
      reportId:      randomUUID(),
      reportType:    "TRADE",
      regulatoryRef: "MiFID II Art. 26 / RTS 22",
      ...params,
      venue:    "IGFX_INTERNAL_LP",
      reportedAt: new Date().toISOString(),
      status:   "PENDING",      // set to SUBMITTED when ARM accepts
    };

    if (IS_PERSISTENT) {
      // Note: the AuditLog row's own id comes from immutableAudit.write(),
      // not report.reportId -- nothing looks up an AuditLog row by
      // reportId (it's referenced only as a payload/entity value
      // elsewhere), so this is safe. report.reportId remains the
      // identifier callers actually use.
      await immutableAudit.write({
        actor: "REGULATORY_REPORTING",
        action: "regulatory.trade_report",
        entity: params.orderId,
        payload: report as unknown as object,
      });
    }

    return report;
  }
}

export const regulatoryReporting = new RegulatoryReportingService();
export default regulatoryReporting;
