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
  private publishing = new Map<
    string,
    { ok: () => void; err: (e: any) => void }
  >();
  private reqs = new Map<string, Req>();
  private openPromise?: Promise<void>;
  private openCb?: () => void;

  constructor(relayUrl: string, agent: SocksProxyAgent) {
    this.relayUrl = relayUrl;
    this.agent = agent;
    this.ws = this.connect();
  }

  private connect() {
    console.log(new Date(), "connecting to", this.relayUrl);
    this.ws = new WebSocket(this.relayUrl, { agent: this.agent });
    this.ws.onopen = this.onOpen.bind(this);
    this.ws.onclose = this.onClose.bind(this);
    this.ws.onerror = this.onError.bind(this);
    this.ws.onmessage = this.onMessage.bind(this);
    // reset open promise
    this.openPromise = new Promise((ok) => (this.openCb = ok));
    return this.ws;
  }

  private onOpen() {
    console.log(new Date(), "opened", this.relayUrl, "reqs", this.reqs.size);
    this.openCb?.();
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
    // reset open promise
    this.openPromise = new Promise((ok) => (this.openCb = ok));
  }

  private onError(e: any) {
    console.log(
      new Date(),
      "relay error",
      this.relayUrl,
      e.error,
      e.message,
      e.type
    );
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
    const id = cmd[1];
    const cbs = this.publishing.get(id);
    if (!cbs) return;
    this.publishing.delete(id);

    const { ok, err } = cbs;
    if (cmd[2]) ok();
    else err("Failed to publish event");
  }

  private send(id: string) {
    const req = this.reqs.get(id)!;
    const filter = { ...req.filter };
    if ((req.since || 0) > (filter.since || 0)) filter.since = req.since;
    const cmd = ["REQ", req.id, filter];
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

  public publish(e: Event, to: number = 10000) {
    return new Promise<void>(async (ok, err) => {
      // timeout handler
      const timer = setTimeout(() => {
        this.publishing.delete(e.id);
        err("Publish timeout");
      }, to);

      // handlers to process OK message
      this.publishing.set(e.id, {
        ok: () => {
          clearTimeout(timer);
          ok();
        },
        err: (e) => {
          clearTimeout(timer);
          err(e);
        },
      });

      // make sure connection is open
      await this.openPromise!;

      // take only valid nostr event fields
      const { id, pubkey, created_at, kind, content, tags, sig } = e;
      const cmd = [
        "EVENT",
        { id, pubkey, created_at, kind, content, tags, sig },
      ];
      console.log("publish", this.relayUrl, cmd[1]);
      this.ws.send(JSON.stringify(cmd));
    });
  }

  public reconnect() {
    console.log(new Date(), "reconnect", this.relayUrl);
    this.ws?.close();
  }
}
