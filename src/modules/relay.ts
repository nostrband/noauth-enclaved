import { SocksProxyAgent } from "socks-proxy-agent";
import { Event, Filter, validateEvent, verifyEvent } from "./nostr-tools";
import { CloseEvent, MessageEvent, WebSocket } from "ws";

const PAUSE = 3000;

export interface RelayOptions {
  relayUrl: string;
  agent: SocksProxyAgent;
}

export interface Req {
  id: string;
  filter: Filter;
  // fetch back vs subscribe for updates
  fetch: boolean;
  // used if fetch=false to re-subscribe since last update
  since?: number;
  onEvent: (e: Event) => void;
  onClosed?: () => void;
  onEOSE?: () => void;
}

export class Relay {
  private relayUrl: string;
  private agent: SocksProxyAgent;
  private ws: WebSocket;
  private publishing = new Map<string, () => void>();
  private reqs = new Map<string, Req>();

  constructor(relayUrl: string, agent: SocksProxyAgent) {
    this.relayUrl = relayUrl;
    this.agent = agent;
    this.ws = this.connect();
  }

  private connect() {
    console.log(new Date(), "connecting to", this.relayUrl);
    const ws = new WebSocket(this.relayUrl, { agent: this.agent });
    ws.onopen = this.onOpen.bind(this);
    ws.onclose = this.onClose.bind(this);
    ws.onerror = this.onError.bind(this);
    ws.onmessage = this.onMessage.bind(this);
    return ws;
  }

  private onOpen() {
    console.log(new Date(), "opened", this.relayUrl, "reqs", this.reqs.size);
    for (const id of this.reqs.keys()) this.send(id);
  }

  private onClose(e: CloseEvent) {
    console.log(
      new Date(),
      "relay closed",
      this.relayUrl,
      e.code,
      e.reason,
      e.wasClean
    );
    setTimeout(this.connect.bind(this), PAUSE);
  }

  private onError(e: any) {
    console.log(new Date(), "relay error", this.relayUrl, e.toString());
  }

  private onMessage(e: MessageEvent) {
    try {
      const cmd = JSON.parse(e.data.toString("utf8"));
      if (!Array.isArray(cmd) || cmd.length === 0)
        throw new Error("Empty relay message");
      switch (cmd[0]) {
        case "EVENT":
          return this.onEvent(cmd);
        case "EOSE":
          return this.onEOSE(cmd);
        case "NOTICE":
          return this.onNotice(cmd);
        case "CLOSED":
          return this.onClosed(cmd);
        case "OK":
          return this.onOK(cmd);
        default:
          throw new Error("Unknown relay message");
      }
    } catch (err) {
      console.log("Bad message", this.relayUrl, err, e.data);
    }
  }

  private onEvent(cmd: any[]) {
    if (cmd.length < 3) throw new Error("Bad EVENT command");
    try {
      const reqId = cmd[1];
      const req = this.reqs.get(reqId);
      // irrelevant
      if (!req) return;

      // verify, validate
      const event = cmd[2];
      if (!validateEvent(event)) throw new Error("Invalid event");
      if (!verifyEvent(event)) throw new Error("Invalid signature");

      // update cursor so that even after some relay issues
      // we know where we stopped the last time
      if (!req.fetch) req.since = event.created_at;

      // notify subscription
      req.onEvent(event);
    } catch (err) {
      console.log("Bad event", this.relayUrl, err, cmd);
    }
  }

  private onEOSE(cmd: any[]) {
    if (cmd.length < 2) throw new Error("Bad EOSE");
    const reqId = cmd[1];
    const req = this.reqs.get(reqId);
    if (!req) return;
    req.onEOSE?.();
    if (req.fetch) this.reqs.delete(reqId);
  }

  private onNotice(cmd: any[]) {
    console.log("notice", this.relayUrl, cmd);
  }

  private onClosed(cmd: any[]) {
    console.log("closed", this.relayUrl, cmd);
    if (cmd.length < 2) throw new Error("Bad CLOSED");
    const reqId = cmd[1];
    const req = this.reqs.get(reqId);
    if (!req) return;
    req.onClosed?.();

    // unconditionally delete the req to make sure
    // we don't keep re-sending this req, as
    // closed is generally "auth-required" thing
    // and we don't support that
    this.reqs.delete(reqId);
  }

  private onOK(cmd: any[]) {
    if (cmd.length < 4) throw new Error("Bad OK command");
    if (cmd[2] === false) throw new Error("Failed to publish event");
    const id = cmd[1];
    const cb = this.publishing.get(id)!;
    this.publishing.delete(id);
    cb();
  }

  private send(id: string) {
    const req = this.reqs.get(id)!;
    const filter = { ...req.filter };
    if ((req.since || 0) > (filter.since || 0)) filter.since = req.since;
    const cmd = ["REQ", req.id, req.filter];
    console.log("req", this.relayUrl, cmd);
    this.ws.send(JSON.stringify(cmd));
  }

  public close(id: string) {
    if (!this.reqs.delete(id)) return;
    if (this.ws.readyState !== 1) return;
    const cmd = ["CLOSE", id];
    console.log("close", this.relayUrl, cmd);
    this.ws.send(JSON.stringify(cmd));
  }

  public req(req: Req) {
    this.reqs.set(req.id, req);
    if (this.ws.readyState === 1) this.send(req.id);
  }

  public publish(e: Event) {
    return new Promise<void>((ok) => {
      this.publishing.set(e.id, ok);
      const { id, pubkey, created_at, kind, content, tags, sig } = e;
      const cmd = [
        "EVENT",
        { id, pubkey, created_at, kind, content, tags, sig },
      ];
      console.log("publish", this.relayUrl, cmd[1]);
      this.ws.send(JSON.stringify(cmd));
    });
  }
}
