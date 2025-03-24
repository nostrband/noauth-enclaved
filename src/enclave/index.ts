import fs from "node:fs";
import { SocksProxyAgent } from "socks-proxy-agent";
import { bytesToHex } from "@noble/hashes/utils";
import {
  Event,
  UnsignedEvent,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "./modules/nostr-tools";
import { PubkeyBatcher, now } from "./modules/utils";
import { Decision, Nip46Req } from "./modules/types";
import { Perms } from "./modules/perms";
import { Nip46Server } from "./modules/nip46";
import { SignerImpl } from "./modules/signer";
import { Relay } from "./modules/relay";
import { nsmGetAttestation, nsmParseAttestation } from "./modules/nsm";
import { KIND_ADMIN, KIND_INSTANCE, KIND_NIP46, REPO } from "./modules/consts";

const KIND_DATA = 30078;
const APP_TAG = "nsec.app/perm";

const ANNOUNCEMENT_INTERVAL = 3600000; // 1h
const BATCH_SIZE = 1;

// nip46 signer for user keys
class Nip46Signer extends Nip46Server {
  private perms: Perms;

  constructor(privkey: Uint8Array, perms: Perms) {
    super(new SignerImpl(privkey), KIND_NIP46);
    this.perms = perms;
  }

  private reqGetPublicKey(_: Nip46Req) {
    return this.getSigner().getPublicKey();
  }

  private async reqSignEvent(req: Nip46Req) {
    const event: UnsignedEvent = JSON.parse(req.params[0]);

    // make sure apps can't force us to modify our own
    // permission events
    if (
      event.kind === KIND_DATA &&
      event.tags.find(
        (t: string[]) => t.length > 1 && t[0] === "t" && t.includes(APP_TAG)
      )
    )
      throw new Error("Forbidden");

    return JSON.stringify(await this.getSigner().signEvent(event));
  }

  private reqNip04Encrypt(req: Nip46Req) {
    return this.getSigner().nip04Encrypt(req.params[0], req.params[1]);
  }

  private reqNip04Decrypt(req: Nip46Req) {
    return this.getSigner().nip04Decrypt(req.params[0], req.params[1]);
  }

  private reqNip44Encrypt(req: Nip46Req) {
    return this.getSigner().nip44Encrypt(req.params[0], req.params[1]);
  }

  private reqNip44Decrypt(req: Nip46Req) {
    return this.getSigner().nip44Decrypt(req.params[0], req.params[1]);
  }

  protected async check(req: Nip46Req): Promise<Decision> {
    const dec = this.perms.check(await this.getSigner().getPublicKey(), req);
    console.log(new Date(), "req dec", dec, req);
    return dec;
  }

  protected async handle(req: Nip46Req): Promise<string> {
    switch (req.method) {
      case "get_public_key":
        return this.reqGetPublicKey(req);
      case "sign_event":
        return this.reqSignEvent(req);
      case "nip04_encrypt":
        return this.reqNip04Encrypt(req);
      case "nip04_decrypt":
        return this.reqNip04Decrypt(req);
      case "nip44_encrypt":
        return this.reqNip44Encrypt(req);
      case "nip44_decrypt":
        return this.reqNip44Decrypt(req);
      default:
        throw new Error("Unknown method");
    }
  }
}

// admin interface for 'import_key' method
class AdminSigner extends Nip46Server {
  private onImportKey: (key: string) => void;

  constructor(
    privkey: Uint8Array,
    { onImportKey }: { onImportKey: (key: string) => void }
  ) {
    super(new SignerImpl(privkey), KIND_ADMIN);
    this.onImportKey = onImportKey;
  }

  protected async check(_: Nip46Req): Promise<Decision> {
    return "allow";
  }

  protected async handle(req: Nip46Req): Promise<string> {
    if (req.method !== "import_key") throw new Error("Unknown method");
    const pubkey = getPublicKey(Buffer.from(req.params[0], "hex"));
    if (pubkey !== req.clientPubkey) throw new Error("Invalid importer");
    this.onImportKey(req.params[0]);
    return "ok";
  }
}

// watch for nip46 requests tagging specific pubkeys on our main relay
class RequestListener {
  private relay: Relay;
  private onRequest: (pubkey: string, event: Event) => void;
  private pubkeys = new PubkeyBatcher(BATCH_SIZE);

  constructor(
    relay: Relay,
    { onRequest }: { onRequest: (pubkey: string, event: Event) => void }
  ) {
    this.relay = relay;
    this.onRequest = onRequest;
  }

  private onEvent(event: Event) {
    switch (event.kind) {
      case KIND_NIP46:
      case KIND_ADMIN:
        const p = event.tags.find((t) => t.length > 1 && t[0] === "p")?.[1];
        if (!p || !this.pubkeys.has(p)) {
          console.log("Unknown pubkey", event);
          return;
        }
        this.onRequest(p, event);
        break;
      default:
        throw new Error("Invalid kind");
    }
  }

  public addPubkey(pubkey: string) {
    const [id, pubkeys] = this.pubkeys.add(pubkey);
    if (!id) return;

    // forward-looking subscription watching
    // for new requests
    this.relay.req({
      id,
      fetch: false,
      filter: {
        "#p": pubkeys,
        kinds: [KIND_NIP46, KIND_ADMIN],
        since: now() - 10,
      },
      // relay.nsec.app mustn't send CLOSED
      onClosed: () => {
        throw new Error("CLOSED");
      },
      onEvent: this.onEvent.bind(this),
    });
  }
}

// load and watch for updates of user perms on a set of relays
class PermListener {
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
    const [id, pubkeys] = this.pubkeys.add(pubkey);
    if (!id) return;

    // send to all relays
    for (const relay of this.relays) {
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
        onClosed: () => {
          relay.close(id);
        },
        onEvent: this.onEvent.bind(this),
      });
    }
  }
}

function startAnnouncing(privkey: Uint8Array, inboxRelayUrl: string, relay: Relay) {
  const announce = async () => {
    const pubkey = getPublicKey(privkey);
    const attestation = nsmGetAttestation(pubkey);
    console.log("attestation", attestation);
    if (!attestation) throw new Error("Failed to get attestation");

    const pkg = JSON.parse(fs.readFileSync("package.json").toString("utf8"));
    console.log("pkg", pkg);

    const { pcrs, module_id } = nsmParseAttestation(attestation);

    /**
from https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html
PCR0	Enclave image file	A contiguous measure of the contents of the image file, without the section data.
PCR1	Linux kernel and bootstrap	A contiguous measurement of the kernel and boot ramfs data.
PCR2	Application	A contiguous, in-order measurement of the user applications, without the boot ramfs.
PCR3	IAM role assigned to the parent instance	A contiguous measurement of the IAM role assigned to the parent instance. Ensures that the attestation process succeeds only when the parent instance has the correct IAM role.
PCR4	Instance ID of the parent instance	A contiguous measurement of the ID of the parent instance. Ensures that the attestation process succeeds only when the parent instance has a specific instance ID.
PCR8	Enclave image file signing certificate	A measure of the signing certificate specified for the enclave image file. Ensures that the attestation process succeeds only when the enclave was booted from an enclave image file signed by a specific certificate.
     */

    const signed = finalizeEvent(
      {
        kind: KIND_INSTANCE,
        created_at: now(),
        content: attestation.toString("base64"),
        tags: [
          ["r", REPO],
          ["name", pkg.name],
          ["v", pkg.version],
          ["m", module_id],
          ...[0, 1, 2, 4, 8].map((id) => [
            "x",
            bytesToHex(pcrs.get(id)!),
            `PCR${id}`,
          ]),
          // admin interface relay with spam protection
          ["relay", inboxRelayUrl],
          // expires in 3 hours, together with attestation doc
          ["expiration", "" + (now() + 3 * 3600)],
        ],
      },
      privkey
    );
    console.log("announcement", signed);
    try {
      await relay.publish(signed);

      // schedule next announcement
      setTimeout(announce, ANNOUNCEMENT_INTERVAL);
    } catch (e) {
      console.log("Failed to announce", e);
      relay.reconnect();

      // retry faster than normal
      setTimeout(announce, ANNOUNCEMENT_INTERVAL / 10);
    }
  };
  announce();
}

export async function startEnclave(opts: {
  relayUrl: string;
  proxyUrl: string;
}) {
  // we're talking to the outside world using socks proxy
  // that lives in enclave parent and our tcp traffic
  // is socat-ed through vsock interface
  console.log(new Date(), "noauth enclave opts", opts);
  const agent = new SocksProxyAgent(opts.proxyUrl);

  // new admin key on every restart
  const adminPrivkey = generateSecretKey();
  const adminPubkey = getPublicKey(adminPrivkey);
  console.log("adminPubkey", adminPubkey);

  // list of nip46 handlers: admin + all user keys
  const keys = new Map<string, Nip46Server>();

  // main relay + listener
  const relay = new Relay(opts.relayUrl, agent);
  const requestListener = new RequestListener(relay, {
    onRequest: async (pubkey: string, e: Event) => {
      const key = keys.get(pubkey);
      if (!key) throw new Error("Unknown key");
      const reply = await key.process(e);
      if (!reply) return; // ignored
      try {
        await relay.publish(reply);
      } catch (err) {
        console.log("failed to publish reply");
        relay.reconnect();
      }
    },
  });

  // perms handler + perms relays + listener
  const perms = new Perms((pubkey: string) => {
    if (pubkey === adminPubkey) return undefined;
    const key = keys.get(pubkey);
    if (key) return key.getSigner();
  });
  // FIXME use outbox relays when nsec.app itself starts using them
  const PERM_RELAYS = [
    "wss://relay.damus.io",
    "wss://relay.nostr.band/all",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://nostr.mom",
  ];
  const permRelays = PERM_RELAYS.map((url) => new Relay(url, agent));
  const permListener = new PermListener(permRelays, {
    onPerms: async (e: Event) => {
      perms.processAppPermEvent(e);
    },
  });

  // helper
  const addKey = (privkey: Uint8Array) => {
    const pubkey = getPublicKey(privkey);
    keys.set(pubkey, new Nip46Signer(privkey, perms));
    requestListener.addPubkey(pubkey);
    permListener.addPubkey(pubkey);
  };

  // handler of 'import_key' method
  const adminSigner = new AdminSigner(adminPrivkey, {
    onImportKey: (key: string) => {
      const privkey = Buffer.from(key, "hex");
      const pubkey = getPublicKey(privkey);
      if (pubkey === adminPubkey) {
        console.log("Can't import bunker key");
        return;
      }
      if (keys.has(pubkey)) {
        console.log("already exists", pubkey);
      } else {
        console.log(new Date(), "imported key", pubkey);
        addKey(privkey);
      }
    },
  });

  // add admin to request listener, but not perms listener
  keys.set(adminPubkey, adminSigner);
  requestListener.addPubkey(adminPubkey);

  // announce ourselves
  startAnnouncing(adminPrivkey, relay.url, relay);
}

// main
export function mainEnclave(argv: string[]) {
  if (!argv.length) throw new Error("Service not specified");
  if (argv[0] === "run") {
    const proxyUrl = argv[1];
    const relayUrl = argv?.[2] || "wss://relay.nsec.app";
    startEnclave({ proxyUrl, relayUrl });
  }
}
