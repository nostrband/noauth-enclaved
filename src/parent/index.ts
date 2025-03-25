// @ts-ignore
import socks5 from "node-socks5-server";
import { RawData, WebSocket, WebSocketServer } from "ws";
import fs from "node:fs";
import {
  Event,
  validateEvent,
  verifyEvent,
} from "../enclave/modules/nostr-tools";
import { verifyBuild, verifyInstance } from "../enclave/modules/parent";
import { nsmParseAttestation } from "../enclave/modules/nsm";
import { fetchOutboxRelays } from "../cli/utils";

interface Req {
  id: string;
  method: string;
  params: string[];
}

interface Rep {
  id: string;
  result: string;
  error?: string;
}

class ParentServer {
  private wss: WebSocketServer;
  private dir: string;

  constructor({ port, dir = "./instance/" }: { port: number; dir?: string }) {
    this.dir = dir;
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", this.onConnect.bind(this));
  }

  private read() {
    const build = JSON.parse(
      fs.readFileSync(this.dir + "/build.json").toString("utf8")
    );
    const instance = JSON.parse(
      fs.readFileSync(this.dir + "/instance.json").toString("utf8")
    );
    console.log("build", build);
    console.log("instance", instance);
    if (!validateEvent(build) || !verifyEvent(build))
      throw new Error("Invalid build.json");
    if (!validateEvent(instance) || !verifyEvent(instance))
      throw new Error("Invalid build.json");

    return { build, instance };
  }

  private onConnect(ws: WebSocket) {
    ws.on("error", console.error);
    const self = this;
    ws.on("message", (data) => self.onMessage(ws, data));
  }

  private async handleStart(params: string[]) {
    const att = Buffer.from(params[0], "base64");
    console.log("start att", att);

    const attData = nsmParseAttestation(att);

    const { build, instance } = this.read();
    // debug enclaves return zero PCR0
    const prodEnclave = !!attData.pcrs.get(0)!.find((c) => c !== 0);
    if (prodEnclave) {
      verifyBuild(attData, build);
      verifyInstance(attData, instance);
    }

    const relays = await fetchOutboxRelays([instance.pubkey]);
    console.log("outbox relays", instance.pubkey, relays);

    return JSON.stringify({
      build: build,
      instance: instance,
      instanceAnnounceRelays: relays,
    });
  }

  private async onMessage(ws: WebSocket, data: RawData) {
    console.log("received: %s", data);
    let rep: Rep | undefined;
    try {
      const req = JSON.parse(data.toString("utf8"));
      console.log("req", req);
      rep = {
        id: req.id,
        result: "",
      };
      switch (req.method) {
        case "start":
          rep.result = await this.handleStart(req.params);
          break;
        default:
          throw new Error("Unknown method");
      }
    } catch (e: any) {
      console.log("Bad req", e, data.toString("utf8"));
      if (rep) rep.error = e.message || e.toString();
    }
    console.log("rep", rep);
    if (rep) {
      ws.send(JSON.stringify(rep));
    } else {
      ws.close();
    }
  }
}

function startParentServer(port: number) {
  new ParentServer({ port });
}

function startProxyServer(port: number) {
  console.log("starting proxy on", port);
  const server = socks5.createServer();
  server.listen(port);
}

export function mainParent(argv: string[]) {
  if (!argv.length) throw new Error("Service not specified");
  if (argv[0] === "run") {
    const socksPort = Number(argv?.[1]) || 1080;
    const parentPort = Number(argv?.[2]) || 2080;
    startProxyServer(socksPort);
    startParentServer(parentPort);
  }
}
