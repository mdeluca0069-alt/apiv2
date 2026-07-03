/**
 * IGFXPRO — FIX 4.4 Acceptor
 *
 * Implements a TCP FIX 4.4 session acceptor.
 * Institutional clients connect via FIX to submit orders and receive
 * execution reports — the same standard used by IBKR, FXPro, and
 * every prime brokerage globally.
 *
 * Architecture:
 *  - Listens on FIX_PORT (default: 9878)
 *  - One TCP connection per FIX session (one client)
 *  - Session state: DISCONNECTED → CONNECTED → LOGON_SENT → ACTIVE → LOGOUT
 *  - Heartbeat enforcement: disconnects sessions that miss 2× HeartBtInt
 *  - Delegates order execution to the injected executor callback
 *  - Sends back ExecutionReport (35=8) on every order action
 */

import * as net from "node:net";
import { EventEmitter } from "node:events";
import {
  SOH,
  Tag,
  MsgType,
  Side,
  OrdType,
  OrdStatus,
  ExecType,
  parseMessage,
  buildLogon,
  buildLogout,
  buildHeartbeat,
  buildExecutionReport,
  type FixFields,
} from "./fix.message.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FixOrderRequest = {
  clOrdId:   string;
  symbol:    string;
  side:      "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT" | "STOP";
  quantity:  number;
  price?:    number;
  stopPx?:   number;
  account:   string;  // userId mapped from FIX Account field
};

export type FixOrderResult = {
  orderId:   string;
  execId:    string;
  status:    "NEW" | "FILLED" | "REJECTED" | "CANCELLED";
  avgPx:     number;
  cumQty:    number;
  leavesQty: number;
  text?:     string;
};

export type FixExecutor = (req: FixOrderRequest) => Promise<FixOrderResult>;
export type FixCancelExecutor = (clOrdId: string, origClOrdId: string, account: string) => Promise<FixOrderResult>;

type SessionState = "DISCONNECTED" | "CONNECTED" | "ACTIVE" | "LOGGING_OUT";

interface FixSession {
  socket:       net.Socket;
  state:        SessionState;
  senderCompID: string;   // their ID
  targetCompID: string;   // our ID (IGFXPRO)
  account:      string;   // userId extracted from Logon
  inSeqNum:     number;
  outSeqNum:    number;
  heartBtInt:   number;   // seconds
  lastMsgTime:  number;   // ms timestamp
  heartbeatTimer: NodeJS.Timeout | null;
  buffer:       string;
}

// ─── FIX Acceptor ─────────────────────────────────────────────────────────────

export class FixAcceptor extends EventEmitter {
  private readonly compId:    string;
  private readonly port:      number;
  private readonly executor:  FixExecutor;
  private readonly canceller: FixCancelExecutor;
  private server: net.Server | null = null;
  private sessions = new Map<string, FixSession>();
  private nextExecId = 1;

  constructor(opts: {
    compId:    string;
    port:      number;
    executor:  FixExecutor;
    canceller: FixCancelExecutor;
  }) {
    super();
    this.compId    = opts.compId;
    this.port      = opts.port;
    this.executor  = opts.executor;
    this.canceller = opts.canceller;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  start(): void {
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on("error", (err) => {
      console.error(`[fix-acceptor] server error: ${err.message}`);
    });
    this.server.listen(this.port, () => {
      console.log(`[fix-acceptor] FIX 4.4 acceptor listening on port ${this.port}`);
    });
  }

  stop(): void {
    for (const [id, session] of this.sessions) {
      this.closeSession(id, session, "Server shutting down");
    }
    this.server?.close();
    console.log("[fix-acceptor] stopped");
  }

  getStats() {
    const sessions = [...this.sessions.values()];
    return {
      activeSessions:   sessions.filter((s) => s.state === "ACTIVE").length,
      totalSessions:    sessions.length,
      port:             this.port,
      compId:           this.compId,
    };
  }

  // ── Connection handling ─────────────────────────────────────────────────────

  private onConnection(socket: net.Socket): void {
    const id = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`[fix-acceptor] new connection from ${id}`);

    const session: FixSession = {
      socket,
      state:        "CONNECTED",
      senderCompID: "",
      targetCompID: this.compId,
      account:      "",
      inSeqNum:     0,
      outSeqNum:    1,
      heartBtInt:   30,
      lastMsgTime:  Date.now(),
      heartbeatTimer: null,
      buffer:       "",
    };
    this.sessions.set(id, session);

    socket.setEncoding("utf8");
    socket.on("data",  (data) => this.onData(id, session, data.toString("utf8")));
    socket.on("close", ()     => this.onClose(id, session));
    socket.on("error", (err)  => {
      console.warn(`[fix-acceptor] socket error [${id}]: ${err.message}`);
      this.onClose(id, session);
    });

    // Hard timeout: if no Logon within 10s, disconnect
    setTimeout(() => {
      if (session.state === "CONNECTED") {
        console.warn(`[fix-acceptor] no Logon from ${id} within 10s — disconnecting`);
        socket.destroy();
      }
    }, 10_000);
  }

  private onData(id: string, session: FixSession, data: string): void {
    session.buffer += data;
    session.lastMsgTime = Date.now();

    // FIX messages end with 10=<checksum>\x01
    // Split on the pattern to extract complete messages
    const endMarker = `${Tag.CheckSum}=`;
    let start = 0;
    let pos: number;

    while ((pos = session.buffer.indexOf(endMarker, start)) !== -1) {
      const soH2 = session.buffer.indexOf(SOH, pos);
      if (soH2 < 0) break; // incomplete checksum field — wait for more data
      const raw = session.buffer.slice(start, soH2 + 1);
      start = soH2 + 1;
      this.processMessage(id, session, raw);
    }
    session.buffer = session.buffer.slice(start);
  }

  private processMessage(id: string, session: FixSession, raw: string): void {
    let fields: FixFields;
    try {
      fields = parseMessage(raw);
    } catch {
      console.warn(`[fix-acceptor] parse error from ${id}`);
      return;
    }

    const msgType = fields[Tag.MsgType];
    session.inSeqNum = parseInt(fields[Tag.MsgSeqNum] ?? "0", 10);

    switch (msgType) {
      case MsgType.Logon:          return this.handleLogon(id, session, fields);
      case MsgType.Heartbeat:      return; // just update lastMsgTime (already done)
      case MsgType.TestRequest:    return this.handleTestRequest(id, session, fields);
      case MsgType.Logout:         return this.handleLogout(id, session);
      case MsgType.NewOrderSingle: return void this.handleNewOrder(id, session, fields);
      case MsgType.OrderCancelRequest: return void this.handleCancel(id, session, fields);
      default:
        console.log(`[fix-acceptor] unhandled MsgType=${msgType} from ${id}`);
    }
  }

  // ── Logon ───────────────────────────────────────────────────────────────────

  private handleLogon(id: string, session: FixSession, fields: FixFields): void {
    const senderCompID = fields[Tag.SenderCompID] ?? "";
    const account      = fields[Tag.Account]      ?? "";
    const heartBtInt   = parseInt(fields[Tag.HeartBtInt] ?? "30", 10);

    if (!account) {
      this.send(session, buildLogout(
        this.compId, senderCompID, session.outSeqNum++,
        "Logon rejected: Account field (tag 1) required for user identification",
      ));
      session.socket.end();
      return;
    }

    session.senderCompID = senderCompID;
    session.account      = account;
    session.heartBtInt   = Math.max(5, Math.min(300, heartBtInt));
    session.state        = "ACTIVE";

    // Acknowledge Logon
    this.send(session, buildLogon(this.compId, senderCompID, session.outSeqNum++, session.heartBtInt));
    console.log(`[fix-acceptor] session ACTIVE: compId=${senderCompID} account=${account} hbInt=${session.heartBtInt}s`);

    // Start heartbeat enforcement
    this.startHeartbeat(id, session);
    this.emit("session.active", { id, senderCompID, account });
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────────

  private startHeartbeat(id: string, session: FixSession): void {
    const intervalMs = session.heartBtInt * 1_000;
    session.heartbeatTimer = setInterval(() => {
      const idle = Date.now() - session.lastMsgTime;
      if (idle > intervalMs * 2) {
        console.warn(`[fix-acceptor] session ${id} missed heartbeat — disconnecting`);
        this.closeSession(id, session, "HeartBeat timeout");
        return;
      }
      if (idle > intervalMs) {
        // Send heartbeat
        this.send(session, buildHeartbeat(this.compId, session.senderCompID, session.outSeqNum++));
      }
    }, intervalMs);
  }

  // ── TestRequest ─────────────────────────────────────────────────────────────

  private handleTestRequest(id: string, session: FixSession, fields: FixFields): void {
    void id;
    const testReqId = fields[Tag.TestReqID];
    this.send(session, buildHeartbeat(
      this.compId, session.senderCompID, session.outSeqNum++, testReqId,
    ));
  }

  // ── Logout ──────────────────────────────────────────────────────────────────

  private handleLogout(id: string, session: FixSession): void {
    this.send(session, buildLogout(this.compId, session.senderCompID, session.outSeqNum++));
    this.closeSession(id, session, "Client requested Logout");
  }

  // ── NewOrderSingle (35=D) ───────────────────────────────────────────────────

  private async handleNewOrder(id: string, session: FixSession, fields: FixFields): Promise<void> {
    void id;
    if (session.state !== "ACTIVE") return;

    const clOrdId  = fields[Tag.ClOrdID]  ?? `fix-${Date.now()}`;
    const symbol   = fields[Tag.Symbol]   ?? "";
    const sideRaw  = fields[Tag.Side]     ?? "1";
    const ordType  = fields[Tag.OrdType]  ?? OrdType.Market;
    const quantity = parseFloat(fields[Tag.OrderQty] ?? "0");
    const price    = fields[Tag.Price]    ? parseFloat(fields[Tag.Price]!) : undefined;
    const stopPx   = fields[Tag.StopPx]   ? parseFloat(fields[Tag.StopPx]!) : undefined;

    const side: "BUY" | "SELL" = sideRaw === Side.Sell ? "SELL" : "BUY";
    const orderType: FixOrderRequest["orderType"] =
      ordType === OrdType.Limit ? "LIMIT" :
      ordType === OrdType.Stop  ? "STOP"  : "MARKET";

    // Send ACK (New) immediately
    this.send(session, buildExecutionReport(
      this.compId, session.senderCompID, session.outSeqNum++,
      {
        orderId:   "PENDING",
        clOrdId,
        execId:    `EXEC-${this.nextExecId++}`,
        symbol,
        side:      sideRaw,
        execType:  ExecType.New,
        ordStatus: OrdStatus.New,
        cumQty:    0,
        leavesQty: quantity,
        avgPx:     0,
        account:   session.account,
      },
    ));

    // Execute via broker engine
    let result: FixOrderResult;
    try {
      result = await this.executor({
        clOrdId, symbol, side, orderType, quantity,
        price, stopPx, account: session.account,
      });
    } catch (err) {
      result = {
        orderId: "REJECTED", execId: `EXEC-${this.nextExecId++}`,
        status: "REJECTED", avgPx: 0, cumQty: 0, leavesQty: quantity,
        text: (err as Error).message,
      };
    }

    const execType  = result.status === "FILLED" ? ExecType.Fill :
                      result.status === "REJECTED" ? ExecType.Rejected :
                      result.status === "CANCELLED" ? ExecType.Cancelled : ExecType.New;
    const ordStatus = result.status === "FILLED" ? OrdStatus.Filled :
                      result.status === "REJECTED" ? OrdStatus.Rejected :
                      result.status === "CANCELLED" ? OrdStatus.Cancelled : OrdStatus.New;

    this.send(session, buildExecutionReport(
      this.compId, session.senderCompID, session.outSeqNum++,
      {
        orderId:   result.orderId,
        clOrdId,
        execId:    result.execId,
        symbol,
        side:      sideRaw,
        execType,
        ordStatus,
        cumQty:    result.cumQty,
        leavesQty: result.leavesQty,
        avgPx:     result.avgPx,
        account:   session.account,
        text:      result.text,
      },
    ));
  }

  // ── OrderCancelRequest (35=F) ────────────────────────────────────────────────

  private async handleCancel(id: string, session: FixSession, fields: FixFields): Promise<void> {
    void id;
    if (session.state !== "ACTIVE") return;

    const clOrdId     = fields[Tag.ClOrdID]     ?? "";
    const origClOrdId = fields[Tag.OrigClOrdID] ?? "";

    let result: FixOrderResult;
    try {
      result = await this.canceller(clOrdId, origClOrdId, session.account);
    } catch (err) {
      result = {
        orderId: origClOrdId, execId: `EXEC-${this.nextExecId++}`,
        status: "REJECTED", avgPx: 0, cumQty: 0, leavesQty: 0,
        text: (err as Error).message,
      };
    }

    this.send(session, buildExecutionReport(
      this.compId, session.senderCompID, session.outSeqNum++,
      {
        orderId:   result.orderId,
        clOrdId,
        execId:    result.execId,
        symbol:    fields[Tag.Symbol] ?? "",
        side:      fields[Tag.Side]   ?? "1",
        execType:  result.status === "CANCELLED" ? ExecType.Cancelled : ExecType.Rejected,
        ordStatus: result.status === "CANCELLED" ? OrdStatus.Cancelled : OrdStatus.Rejected,
        cumQty:    result.cumQty,
        leavesQty: result.leavesQty,
        avgPx:     result.avgPx,
        account:   session.account,
        text:      result.text,
      },
    ));
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  private send(session: FixSession, msg: string): void {
    try {
      if (session.socket.writable) {
        session.socket.write(msg);
      }
    } catch (err) {
      console.warn("[fix-acceptor] send error:", (err as Error).message);
    }
  }

  private closeSession(id: string, session: FixSession, reason: string): void {
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = null;
    }
    session.state = "LOGGING_OUT";
    try { session.socket.destroy(); } catch { /* ignore */ }
    this.sessions.delete(id);
    console.log(`[fix-acceptor] session ${id} closed: ${reason}`);
    this.emit("session.closed", { id, reason });
  }

  private onClose(id: string, session: FixSession): void {
    if (session.state !== "LOGGING_OUT") {
      this.closeSession(id, session, "Remote disconnect");
    }
  }
}

// ─── Singleton with lazy init ─────────────────────────────────────────────────

let _acceptor: FixAcceptor | null = null;

export function getFixAcceptor(): FixAcceptor | null {
  return _acceptor;
}

export function initFixAcceptor(
  executor:  FixExecutor,
  canceller: FixCancelExecutor,
  port = 9878,
): FixAcceptor {
  _acceptor = new FixAcceptor({
    compId:    "IGFXPRO",
    port:      Number(process.env.FIX_PORT ?? port),
    executor,
    canceller,
  });
  _acceptor.start();
  return _acceptor;
}
