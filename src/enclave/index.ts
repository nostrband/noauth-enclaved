import { SocksProxyAgent } from "socks-proxy-agent";
import {
  Event,
  UnsignedEvent,
  generateSecretKey,
  getPublicKey,
} from "./modules/nostr-tools";
import { normalizeRelay } from "./modules/utils";
import { Decision, Nip46Req } from "./modules/types";
import { Perms } from "./modules/perms";
import { Nip46Server } from "./modules/nip46";
import { SignerImpl } from "./modules/signer";
import { Relay } from "./modules/relay";
import { APP_TAG, KIND_ADMIN, KIND_DATA, KIND_NIP46 } from "./modules/consts";
import { getInfo } from "./modules/parent";
import { PermListener, RequestListener } from "./modules/listeners";
import { startAnnouncing } from "./modules/announce";

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

interface AdminMethods {
  onImportKey: (key: string, relays: string) => string;
  onConnectKey: (key: string, connectPubkey: string, relays: string) => string;
  onDeleteKey: (clientPubkey: string) => string;
}

// admin interface for 'import_key' method
class AdminSigner extends Nip46Server {
  private methods: AdminMethods;

  constructor(privkey: Uint8Array, methods: AdminMethods) {
    super(new SignerImpl(privkey), KIND_ADMIN);
    this.methods = methods;
  }

  protected async check(_: Nip46Req): Promise<Decision> {
    return "allow";
  }

  protected async handle(req: Nip46Req): Promise<string> {
    switch (req.method) {
      case "import_key":
        return this.methods.onImportKey(req.params[0], req.params?.[1] || "");
      case "delete_key":
        return this.methods.onDeleteKey(req.clientPubkey);
      case "connect_key":
        return this.methods.onConnectKey(
          req.params[0],
          req.params[1],
          req.params?.[2] || ""
        );
      default:
        throw new Error("Unknown method");
    }
  }
}

export async function startEnclave(opts: {
  relayUrl: string;
  proxyUrl: string;
  parentUrl: string;
}) {
  const { build, instance, instanceAnnounceRelays } = await getInfo(
    opts.parentUrl
  );

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

  // request handler
  const process = async (e: Event, signer: Nip46Server, relay: Relay) => {
    const reply = await signer.process(e);
    if (!reply) return; // ignored
    try {
      await relay.publish(reply);
    } catch (err) {
      console.log("failed to publish reply");
      relay.reconnect();
    }
  };

  const requestListener = new RequestListener(agent, {
    onRequest: async (relay: Relay, pubkey: string, e: Event) => {
      const key = keys.get(pubkey);
      if (!key) throw new Error("Unknown key");
      await process(e, key, relay);
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
  const addKey = (privkey: Uint8Array, relaysStr: string) => {
    const relays = [
      ...new Set(
        relaysStr
          .split(",")
          .map((r) => r.trim())
          .map((r) => normalizeRelay(r))
          .filter((r) => !!r) as string[]
      ),
    ];

    const pubkey = getPublicKey(privkey);
    keys.set(pubkey, new Nip46Signer(privkey, perms));
    requestListener.addPubkey(pubkey, relays);
    permListener.addPubkey(pubkey);
  };

  // handler of 'import_key' method
  const adminSigner = new AdminSigner(adminPrivkey, {
    onImportKey: (key: string, relays: string) => {
      const privkey = Buffer.from(key, "hex");
      const pubkey = getPublicKey(privkey);
      if (pubkey === adminPubkey) throw new Error("Can't import bunker key");
      // FIXME what if list of relays changed?
      if (keys.has(pubkey)) {
        console.log("already exists", pubkey);
      } else {
        console.log(new Date(), "imported key", pubkey);
        addKey(privkey, relays);
      }
      return "ok";
    },
    onConnectKey(key, connectPubkey, relays) {
      const privkey = Buffer.from(key, "hex");
      const pubkey = getPublicKey(privkey);
      if (pubkey === adminPubkey) throw new Error("Can't import bunker key");
      // FIXME what if list of relays changed?
      if (keys.has(pubkey)) {
        console.log("already exists", pubkey);
      } else {
        console.log(new Date(), "imported key", pubkey);
        addKey(privkey, relays);
      }
      // assign full-access perms
      perms.connect(pubkey, connectPubkey);
      return "ok";
    },
    onDeleteKey(pubkey) {
      keys.delete(pubkey);
      requestListener.removePubkey(pubkey);
      permListener.removePubkey(pubkey);
      return "ok";
    },
  });

  // main relay + admin listener
  const adminRequestListener = new RequestListener(agent, {
    onRequest: async (relay: Relay, pubkey: string, e: Event) => {
      if (pubkey !== adminPubkey) throw new Error("Unknown key");
      await process(e, adminSigner, relay);
    },
  });
  // add admin to request listener, but not perms listener
  adminRequestListener.addPubkey(adminPubkey, [opts.relayUrl]);

  // announce ourselves
  startAnnouncing({
    agent,
    build,
    instance,
    privkey: adminPrivkey,
    inboxRelayUrl: opts.relayUrl,
    instanceAnnounceRelays,
  });
}

// main
export function mainEnclave(argv: string[]) {
  if (!argv.length) throw new Error("Service not specified");
  if (argv[0] === "run") {
    const proxyUrl = argv?.[1] || "socks://127.0.0.1:1080";
    const parentUrl = argv?.[2] || "ws://127.0.0.1:2080";
    const relayUrl = argv?.[3] || "wss://relay.nsec.app";
    startEnclave({ proxyUrl, parentUrl, relayUrl });
  }
}
