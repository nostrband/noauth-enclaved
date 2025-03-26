import { SocksProxyAgent } from "socks-proxy-agent";
import { APP_TAG, KIND_ADMIN, KIND_DATA, KIND_NIP46 } from "./consts";
import { Event } from "./nostr-tools";
import { Relay } from "./relay";
import { PubkeyBatcher, now } from "./utils";

const BATCH_SIZE = 1;

// watch for nip46 requests tagging specific pubkeys on our main relay
export class RequestListener {
  private agent: SocksProxyAgent;
  private relays = new Map<string, Relay>();
  private onRequest: (relay: Relay, pubkey: string, event: Event) => void;
  private pubkeys = new PubkeyBatcher(BATCH_SIZE);

  constructor(
    agent: SocksProxyAgent,
    {
      onRequest,
    }: { onRequest: (relay: Relay, pubkey: string, event: Event) => void }
  ) {
    this.agent = agent;
    this.onRequest = onRequest;
  }

  private onEvent(relay: Relay, event: Event) {
    switch (event.kind) {
      case KIND_NIP46:
      case KIND_ADMIN:
        const p = event.tags.find((t) => t.length > 1 && t[0] === "p")?.[1];
        if (!p || !this.pubkeys.has(p)) {
          console.log("Unknown pubkey", event);
          return;
        }
        this.onRequest(relay, p, event);
        break;
      default:
        throw new Error("Invalid kind");
    }
  }

  public addPubkey(pubkey: string, relays: string[]) {
    for (const url of relays) {
      const [id, pubkeys] = this.pubkeys.add(pubkey, url);
      if (!id) continue;

      // forward-looking subscription watching
      // for new requests, id will be the same to a previous
      // id of a batch so a new REQ will override the old REQ on relay
      const relay = this.relays.get(url) || new Relay(url, this.agent);
      relay.req({
        id,
        fetch: false,
        filter: {
          "#p": pubkeys,
          kinds: [KIND_NIP46, KIND_ADMIN],
          since: now() - 10,
        },
        onClosed: () => relay.close(id),
        onEvent: (e: Event) => this.onEvent(relay, e),
      });
    }
  }
}

// load and watch for updates of user perms on a set of relays
export class PermListener {
  private relays: Relay[];
  private onPerms: (event: Event) => void;
  private pubkeys = new PubkeyBatcher(BATCH_SIZE);

  constructor(
    relays: Relay[],
    { onPerms }: { onPerms: (event: Event) => void }
  ) {
    this.relays = relays;
    this.onPerms = onPerms;
  }

  private onEvent(event: Event) {
    switch (event.kind) {
      case KIND_DATA:
        if (!this.pubkeys.has(event.pubkey)) {
          console.log("Unknown pubkey", event);
          return;
        }
        this.onPerms(event);
        break;
      default:
        throw new Error("Invalid kind");
    }
  }

  public addPubkey(pubkey: string) {

    // send to all relays
    for (const relay of this.relays) {
      const [id, pubkeys] = this.pubkeys.add(pubkey, relay.url);
      if (!id) continue;

      // fetch all existing perms only
      // for this pubkey
      const fetchId = "fetch:" + pubkey.substring(0, 6);
      relay.req({
        id: fetchId,
        fetch: true,
        filter: {
          authors: [pubkey],
          "#t": [APP_TAG],
          kinds: [KIND_DATA],
          // don't go crazy
          limit: 100,
        },
        onEvent: this.onEvent.bind(this),
      });

      // resubscribe to listen to perm updates
      relay.req({
        id,
        fetch: false,
        filter: {
          authors: pubkeys,
          "#t": [APP_TAG],
          kinds: [KIND_DATA],
          since: now() - 10,
        },
        onClosed: () => relay.close(id),
        onEvent: this.onEvent.bind(this),
      });
    }
  }
}
