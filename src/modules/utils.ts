import { bytesToHex, randomBytes } from "@noble/hashes/utils";

export function now() {
  return Math.floor(Date.now() / 1000);
}

export class PubkeyBatcher {
  private batchSize: number;
  private pubkeys = new Set<string>();
  private reqs = new Map<string, string[]>();

  constructor(batchSize: number) {
    this.batchSize = batchSize;
  }

  public add(pubkey: string): [string, string[]] {
    if (this.pubkeys.has(pubkey)) return ["", []];

    this.pubkeys.add(pubkey);
    let id = [...this.reqs.entries()].find(
      ([_, pubkeys]) => pubkeys.length < this.batchSize
    )?.[0];
    if (!id) {
      id = bytesToHex(randomBytes(6));
      this.reqs.set(id, []);
    }
    const reqPubkeys = this.reqs.get(id)!;
    reqPubkeys.push(pubkey);

    return [id, reqPubkeys];
  }

  public has(pubkey: string) {
    return this.pubkeys.has(pubkey);
  }
}
