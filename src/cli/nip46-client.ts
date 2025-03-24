import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import {
  Event,
  UnsignedEvent,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  validateEvent,
  verifyEvent,
} from "../enclave/modules/nostr-tools";
import { Relay } from "../enclave/modules/relay";
import { KIND_NIP46 } from "../enclave/modules/consts";
import { Nip44 } from "../enclave/modules/nip44";
import { now } from "../enclave/modules/utils";
import { Signer } from "../enclave/modules/types";
import fs from "node:fs";

const nip44 = new Nip44();

export class Nip46Client implements Signer {
  private kind: number;
  private perms: string;
  private relay: Relay;
  private filename?: string;
  private signerPubkey?: string;

  private userPubkey?: string;
  private privkey?: Uint8Array;
  private pending = new Map<
    string,
    {
      ok: (result: string) => void;
      err: (e: any) => void;
    }
  >();

  constructor({
    relayUrl,
    perms = "",
    kind = KIND_NIP46,
    filename,
    signerPubkey,
    privkey,
  }: {
    relayUrl: string;
    perms?: string;
    kind?: number;
    filename?: string;
    signerPubkey?: string;
    privkey?: Uint8Array;
  }) {
    this.kind = kind;
    this.perms = perms;
    this.relay = new Relay(relayUrl);
    this.filename = filename;
    this.signerPubkey = signerPubkey;
    this.privkey = privkey;
  }

  public getRelay() {
    return this.relay;
  }

  public async send({
    method,
    params,
    timeout = 30000,
  }: {
    method: string;
    params: string[];
    timeout?: number;
  }) {
    if (!this.privkey || !this.signerPubkey) throw new Error("Not started");

    const req = {
      id: bytesToHex(randomBytes(6)),
      method,
      params,
    };

    const event = finalizeEvent(
      {
        created_at: Math.floor(Date.now() / 1000),
        kind: this.kind,
        content: nip44.encrypt(
          this.privkey,
          this.signerPubkey,
          JSON.stringify(req)
        ),
        tags: [["p", this.signerPubkey]],
      },
      this.privkey
    );
    console.log("sending", event);
    await this.relay.publish(event);

    return new Promise<string>((ok, err) => {
      this.pending.set(req.id, { ok, err });
      setTimeout(() => {
        const cbs = this.pending.get(req.id);
        if (cbs) {
          this.pending.delete(req.id);
          cbs.err("Request timeout");
        }
      }, timeout);
    });
  }

  private onReplyEvent(e: Event) {
    const { id, result, error } = JSON.parse(
      nip44.decrypt(this.privkey!, this.signerPubkey!, e.content)
    );
    console.log("reply", { id, result, error });
    if (result === "auth_url") {
      console.log("Open auth url: ", error);
      return;
    }

    const cbs = this.pending.get(id);
    if (!cbs) return;
    this.pending.delete(id);

    if (error) cbs.err(error);
    else cbs.ok(result);
  }

  private subscribe() {
    this.relay.req({
      fetch: false,
      id: bytesToHex(randomBytes(6)),
      filter: {
        kinds: [this.kind],
        authors: [this.signerPubkey!],
        "#p": [getPublicKey(this.privkey!)],
        since: now() - 10,
      },
      onEvent: this.onReplyEvent.bind(this),
    });
  }

  private async nostrconnect() {
    const secret = bytesToHex(randomBytes(16));
    const nostrconnect = `nostrconnect://${getPublicKey(this.privkey!)}?relay=${
      this.relay.url
    }&perms=${this.perms}&name=noauth_enclaved_cli&secret=${secret}`;
    console.log("Connect using this string:");
    console.log(nostrconnect);

    return new Promise<void>((ok) => {
      const onEvent = (e: Event) => {
        const {
          id: replyId,
          result,
          error,
        } = JSON.parse(
          nip44.decrypt(this.privkey!, e.pubkey, e.content)
        );
        console.log("nostrconnect reply", { replyId, result, error });
        if (result === secret) {
          console.log("connected to", e.pubkey);
          this.signerPubkey = e.pubkey;
          ok();
        }
      };

      this.relay.req({
        fetch: false,
        id: bytesToHex(randomBytes(6)),
        filter: {
          kinds: [this.kind],
          "#p": [getPublicKey(this.privkey!)],
          since: now() - 10,
        },
        onEvent,
      });
    });
  }

  public async start() {
    if (this.filename) {
      try {
        const data = fs.readFileSync(this.filename).toString("utf8");
        const { csk, spk } = JSON.parse(data);
        if (csk && spk) {
          this.privkey = Buffer.from(csk, "hex");
          this.signerPubkey = spk;
        }
      } catch {}
    }

    if (!this.privkey) {
      this.privkey = generateSecretKey();
      if (this.signerPubkey) {
        const ack = await this.send({
          method: "connect",
          params: [this.signerPubkey, "", this.perms],
        });
        if (ack !== "ack") throw new Error("Failed to connect");
      } else {
        await this.nostrconnect();
      }
    }
    this.subscribe();

    if (this.filename) {
      fs.writeFileSync(
        this.filename,
        JSON.stringify({
          csk: bytesToHex(this.privkey!),
          spk: this.signerPubkey,
        })
      );
    }
  }

  async getPublicKey(): Promise<string> {
    if (this.userPubkey) return this.userPubkey;

    const pk = await this.send({
      method: "get_public_key",
      params: [],
    });
    if (pk.length !== 64) throw new Error("Invalid pubkey");
    this.userPubkey = pk;
    return pk;
  }
  async nip04Decrypt(pubkey: string, data: string): Promise<string> {
    return await this.send({
      method: "nip04_decrypt",
      params: [pubkey, data],
    });
  }
  async nip04Encrypt(pubkey: string, data: string): Promise<string> {
    return await this.send({
      method: "nip04_encrypt",
      params: [pubkey, data],
    });
  }
  async nip44Decrypt(pubkey: string, data: string): Promise<string> {
    return await this.send({
      method: "nip44_decrypt",
      params: [pubkey, data],
    });
  }
  async nip44Encrypt(pubkey: string, data: string): Promise<string> {
    return await this.send({
      method: "nip44_encrypt",
      params: [pubkey, data],
    });
  }
  async signEvent(event: UnsignedEvent): Promise<Event> {
    const reply = await this.send({
      method: "sign_event",
      params: [JSON.stringify(event)],
    });
    const signed = JSON.parse(reply);
    if (!validateEvent(signed) || !verifyEvent(signed))
      throw new Error("Invalid event signed");
    return signed;
  }
}
