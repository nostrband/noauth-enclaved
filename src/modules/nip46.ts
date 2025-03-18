import { Decision, Nip46Req, Signer } from "./types";
import { Event, nip19 } from "./nostr-tools";
import { now } from "./utils";

const NSEC_APP_ORIGIN = "https://use.nsec.app";

export class Nip46 {
  private signer: Signer;
  private kind: number;

  constructor(signer: Signer, kind: number) {
    this.signer = signer;
    this.kind = kind;
  }

  public getSigner() {
    return this.signer;
  }

  protected async check(req: Nip46Req): Promise<Decision> {
    throw new Error("Unknown method");
  }

  protected async handle(req: Nip46Req): Promise<string> {
    throw new Error("Unknown method");
  }

  // process event tagging pubkey
  public async process(e: Event): Promise<Event | undefined> {
    if (e.kind !== this.kind) return; // ignore irrelevant kinds
    const res = {
      id: "",
      error: "",
      result: "",
    };

    try {
      const data = await this.signer.nip44Decrypt(e.pubkey, e.content);
      const { id, method, params } = JSON.parse(data);
      if (!id || !method || !params) throw new Error("Bad request");
      res.id = id;

      const req: Nip46Req = {
        clientPubkey: e.pubkey,
        id,
        method,
        params,
      };

      const dec = await this.check(req);
      switch (dec) {
        case "allow":
          res.result = await this.handle(req);
          break;
        case "disallow":
          res.error = "Disallowed";
          break;
        case "ask":
          const npub = nip19.npubEncode(await this.getSigner().getPublicKey());
          res.result = "auth_url";
          res.error = `${NSEC_APP_ORIGIN}/key/${npub}?confirm-event=true&reqId=${id}&popup=true`;
          break;
        case "ignore":
          return undefined;
      }
      console.log(
        new Date(),
        "processed",
        { id, method, params },
        { dec, res }
      );
    } catch (err: any) {
      console.log("Bad event ", err, e);
      res.error = err.message || err.toString();
    }

    return this.signer.signEvent({
      pubkey: await this.signer.getPublicKey(),
      kind: this.kind,
      created_at: now(),
      tags: [["p", e.pubkey]],
      content: await this.signer.nip44Encrypt(e.pubkey, JSON.stringify(res)),
    });
  }
}
