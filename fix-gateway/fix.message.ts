/**
 * FIX 4.4 Message Builder / Parser
 * Implements core message types for the IGFXPRO FIX Acceptor.
 */

export const SOH = "\x01"; // FIX field delimiter

// ─── Field Tags ───────────────────────────────────────────────────────────────
export enum Tag {
  BeginString  = 8,
  BodyLength   = 9,
  MsgType      = 35,
  SenderCompID = 49,
  TargetCompID = 56,
  MsgSeqNum    = 34,
  SendingTime  = 52,
  CheckSum     = 10,
  EncryptMethod= 98,
  HeartBtInt   = 108,
  ResetSeqNumFlag = 141,
  TestReqID    = 112,
  Text         = 58,
  // Order fields
  ClOrdID      = 11,
  OrderID      = 37,
  ExecID       = 17,
  Symbol       = 55,
  Side         = 54,
  OrderQty     = 38,
  OrdType      = 40,
  Price        = 44,
  StopPx       = 99,
  TimeInForce  = 59,
  TransactTime = 60,
  Account      = 1,
  // Execution Report
  ExecType     = 150,
  OrdStatus    = 39,
  LeavesQty    = 151,
  CumQty       = 14,
  AvgPx        = 6,
  // Cancel
  OrigClOrdID  = 41,
}

// ─── Enum values ─────────────────────────────────────────────────────────────
export enum MsgType {
  Heartbeat            = "0",
  TestRequest          = "1",
  Logon                = "A",
  Logout               = "5",
  NewOrderSingle       = "D",
  OrderCancelRequest   = "F",
  OrderCancelReplace   = "G",
  ExecutionReport      = "8",
  OrderCancelReject    = "9",
}

export enum Side   { Buy = "1", Sell = "2" }
export enum OrdType { Market = "1", Limit = "2", Stop = "3", StopLimit = "4" }
export enum OrdStatus { New = "0", Filled = "2", Cancelled = "4", Rejected = "8" }
export enum ExecType  { New = "0", Fill = "F", Cancelled = "4", Rejected = "8" }

// ─── Message parser ───────────────────────────────────────────────────────────
export type FixFields = Record<number, string>;

export function parseMessage(raw: string): FixFields {
  const fields: FixFields = {};
  const parts = raw.split(SOH);
  for (const part of parts) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const tag = parseInt(part.slice(0, eq), 10);
    const val = part.slice(eq + 1);
    if (!isNaN(tag)) fields[tag] = val;
  }
  return fields;
}

// ─── Message builder ──────────────────────────────────────────────────────────
export function buildMessage(
  msgType: string,
  senderCompID: string,
  targetCompID: string,
  seqNum: number,
  bodyFields: Record<number, string | number>,
): string {
  const sendingTime = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").slice(0, 17);

  // Build body (everything except 8, 9, 10)
  const bodyParts = [
    `${Tag.MsgType}=${msgType}`,
    `${Tag.SenderCompID}=${senderCompID}`,
    `${Tag.TargetCompID}=${targetCompID}`,
    `${Tag.MsgSeqNum}=${seqNum}`,
    `${Tag.SendingTime}=${sendingTime}`,
  ];
  for (const [tag, val] of Object.entries(bodyFields)) {
    bodyParts.push(`${tag}=${val}`);
  }
  const body = bodyParts.join(SOH) + SOH;
  const bodyLength = Buffer.byteLength(body, "utf8");

  // Prepend header
  const header = `${Tag.BeginString}=FIX.4.4${SOH}${Tag.BodyLength}=${bodyLength}${SOH}`;
  const raw    = header + body;

  // Compute checksum
  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw.charCodeAt(i);
  const checksum = (sum % 256).toString().padStart(3, "0");

  return raw + `${Tag.CheckSum}=${checksum}${SOH}`;
}

// ─── Pre-built message helpers ────────────────────────────────────────────────

export function buildHeartbeat(sender: string, target: string, seqNum: number, testReqId?: string): string {
  const extra: Record<number, string | number> = testReqId ? { [Tag.TestReqID]: testReqId } : {};
  return buildMessage(MsgType.Heartbeat, sender, target, seqNum, extra);
}

export function buildLogon(sender: string, target: string, seqNum: number, heartBtInt = 30): string {
  return buildMessage(MsgType.Logon, sender, target, seqNum, {
    [Tag.EncryptMethod]: 0,
    [Tag.HeartBtInt]:    heartBtInt,
    [Tag.ResetSeqNumFlag]: "Y",
  });
}

export function buildLogout(sender: string, target: string, seqNum: number, text?: string): string {
  const extra: Record<number, string | number> = text ? { [Tag.Text]: text } : {};
  return buildMessage(MsgType.Logout, sender, target, seqNum, extra);
}

export function buildExecutionReport(
  sender: string, target: string, seqNum: number,
  params: {
    orderId:  string;
    clOrdId:  string;
    execId:   string;
    symbol:   string;
    side:     string;
    execType: string;
    ordStatus:string;
    cumQty:   number;
    leavesQty:number;
    avgPx:    number;
    account:  string;
    text?:    string;
  },
): string {
  const fields: Record<number, string | number> = {
    [Tag.OrderID]:    params.orderId,
    [Tag.ClOrdID]:    params.clOrdId,
    [Tag.ExecID]:     params.execId,
    [Tag.Symbol]:     params.symbol,
    [Tag.Side]:       params.side,
    [Tag.ExecType]:   params.execType,
    [Tag.OrdStatus]:  params.ordStatus,
    [Tag.CumQty]:     params.cumQty,
    [Tag.LeavesQty]:  params.leavesQty,
    [Tag.AvgPx]:      params.avgPx,
    [Tag.Account]:    params.account,
  };
  if (params.text) fields[Tag.Text] = params.text;
  return buildMessage(MsgType.ExecutionReport, sender, target, seqNum, fields);
}
