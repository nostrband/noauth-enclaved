// from noauth/backend.ts

import { nip19 } from "nostr-tools";
import { Event } from "./nostr-tools";
import { Decision, Nip46Req, Signer } from "./types";

interface Perm {
  perm: string;
  value: string;
  timestamp: number;
}

interface App {
  appNpub: string;
  npub: string;
  timestamp: number;
  updateTimestamp: number;
  permUpdateTimestamp: number;
  perms: Perm[];
}

export class Perms {
  private getSigner: (pubkey: string) => Signer | undefined;
  private apps = new Map<string, App>();
  private eventIds = new Set<string>();

  constructor(getSigner: (pubkey: string) => Signer | undefined) {
    this.getSigner = getSigner;
  }

  private appId(app: App | { appNpub: string; npub: string }) {
    return app.npub + app.appNpub;
  }

  private isValidAppPerms(d: any) {
    if (d.npub && d.appNpub && d.updateTimestamp && d.deleted) return true;

    if (
      !d.npub ||
      !d.appNpub ||
      !d.timestamp ||
      !d.updateTimestamp ||
      !d.permUpdateTimestamp
    )
      return false;

    for (const p of d.perms) {
      if (!p.id || !p.npub || !p.appNpub || !p.perm || !p.timestamp)
        return false;
    }

    return true;
  }

  private mergeAppPerms(data: any) {
    const id = this.appId(data);
    const app = this.apps.get(id);

    const newAppInfo = !app || app.updateTimestamp < data.updateTimestamp;
    const newPerms = !app || app.permUpdateTimestamp < data.permUpdateTimestamp;

    const appFromData = (): App => {
      return {
        npub: data.npub,
        appNpub: data.appNpub,
        // choose older creation timestamp
        timestamp: app
          ? Math.min(app.timestamp, data.timestamp)
          : data.timestamp,
        updateTimestamp: data.updateTimestamp,
        // choose newer perm update timestamp
        permUpdateTimestamp: app
          ? Math.max(app.permUpdateTimestamp, data.permUpdateTimestamp)
          : data.permUpdateTimestamp,
        perms: [],
      };
    };

    if (!app && data.deleted) {
      // already deleted
      console.log("App already deleted", { data });
    } else if (!app) {
      // new app
      const newApp = appFromData();
      this.apps.set(id, newApp);
      console.log("New app from event", { data, newApp });
    } else if (newAppInfo) {
      // update existing app
      if (data.deleted) {
        this.apps.delete(id);
        console.log("Delete app from event", { data });
      } else {
        const appUpdate = appFromData();
        this.apps.set(id, appUpdate);
        console.log("Update app from event", { data, appUpdate });
      }
    } else {
      // old data
      console.log("Skip old app info from event", { data, app });
    }

    // merge perms
    if (newPerms && !data.deleted) {
      const app = this.apps.get(id);
      if (!app) throw new Error("WTF?");

      // drop all existing perms
      app.perms.length = 0;

      // set timestamp from the peer
      app.permUpdateTimestamp = data.permUpdateTimestamp;

      // add all perms from peer
      for (const p of data.perms) {
        const perm: Perm = {
          perm: p.perm,
          value: p.value,
          timestamp: p.timestamp,
        };
        app.perms.push(perm);
      }

      console.log("updated perms from data", data);
    }
  }

  private getSignReqKind(req: Nip46Req) {
    return JSON.parse(req.params[0]).kind;
  }

  private getReqPerm(req: Nip46Req): string {
    if (req.method === "sign_event") {
      const kind = this.getSignReqKind(req);
      if (kind !== undefined) return `${req.method}:${kind}`;
    }
    return req.method;
  }

  private isPackagePerm(perm: string, reqPerm: string) {
    if (perm === "basic") {
      switch (reqPerm) {
        case "connect":
        case "get_public_key":
        case "nip04_decrypt":
        case "nip04_encrypt":
        case "nip44_decrypt":
        case "nip44_encrypt":
        case "sign_event:0":
        case "sign_event:1":
        case "sign_event:3":
        case "sign_event:6":
        case "sign_event:7":
        case "sign_event:9734":
        case "sign_event:10002":
        case "sign_event:30023":
        case "sign_event:10000":
        case "sign_event:27235":
          return true;
      }
    }
    return false;
  }

  public async processAppPermEvent(e: Event) {
    // if this pubkey allowed?
    const signer = this.getSigner(e.pubkey);
    if (!signer) return;

    // if signer exists - dedup
    if (this.eventIds.has(e.id)) return;
    this.eventIds.add(e.id);

    // parse
    try {
      const payload = await signer.nip04Decrypt(e.pubkey, e.content);
      const data = JSON.parse(payload);
      console.log("Got app perm event", e.id, { e, data });
      // validate first
      if (this.isValidAppPerms(data)) this.mergeAppPerms(data);
      else console.log("Skip invalid app perms", data);
      console.log("Finished app perm event", e.id);
    } catch (err) {
      console.log("Bad app perm event", e, err);
    }
  }

  public check(pubkey: string, req: Nip46Req): Decision {
    const reqPerm = this.getReqPerm(req);
    const appId = this.appId({
      npub: nip19.npubEncode(pubkey),
      appNpub: nip19.npubEncode(req.clientPubkey),
    });
    const appPerms = this.apps.get(appId)?.perms;
    if (!appPerms || !appPerms.length) return "ignore";

    // exact match first
    let perm = appPerms.find((p) => p.perm === reqPerm);
    // non-exact next
    if (!perm) perm = appPerms.find((p) => this.isPackagePerm(p.perm, reqPerm));

    if (perm) {
      console.log("req", req, "perm", reqPerm, "value", perm, appPerms);
      // connect reqs are always 'ignore' if were disallowed
      if (perm.perm === "connect" && perm.value === "0") return "ignore";

      // all other reqs are not ignored
      return perm.value === "1" ? "allow" : "disallow";
    }

    const conn = appPerms.find((p) => p.perm === "connect");
    if (conn && conn.value === "0") {
      console.log("req", req, "perm", reqPerm, "ignore by connect disallow");
      return "ignore";
    }

    // no perm - need to ask the user
    return "ask";
  }
}
