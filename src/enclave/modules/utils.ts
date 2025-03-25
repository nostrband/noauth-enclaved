import { sha384 } from "@noble/hashes/sha2";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { X509Certificate } from "crypto";
import { nip19 } from "./nostr-tools";

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

export function pcrDigest(data: Buffer | Uint8Array | string) {
  return bytesToHex(
    sha384
      .create()
      // https://github.com/aws/aws-nitro-enclaves-cli/issues/446#issuecomment-1460766038
      // The PCR registers start in a known zero state and each extend operation does a hash between the previous state and the data. 
      .update(new Uint8Array(384 / 8))
      .update(data)
      .digest()
  )
}

export function validateBuildCert(certData: string, pubkey: string, pcr8: string) {
  certData = "-----BEGIN CERTIFICATE-----\n" + certData + "\n-----END CERTIFICATE-----\n";
  const cert = new X509Certificate(certData);
  console.log("cert", cert);
  if (!cert.checkIssued(cert)) throw new Error("Cert not self-signed");
  const now = new Date();
  if (cert.validFromDate > now || cert.validToDate < now) throw new Error("Cert expired"); 
  if (!cert.verify(cert.publicKey)) throw new Error("Invalid cert signature");
  const O = cert.issuer.split("\n").find(s => s.startsWith("O="))?.split("=")[1];
  if (O !== "Nostr") throw new Error("Cert not for Nostr");
  const OU = cert.issuer.split("\n").find(s => s.startsWith("OU="))?.split("=")[1];
  const npub = nip19.npubEncode(pubkey);
  if (OU !== npub) throw new Error("Wrong cert pubkey");

  // pcr8 validation https://github.com/aws/aws-nitro-enclaves-cli/issues/446#issuecomment-1460766038
  const fingerprint = sha384(cert.raw);
  const certPCR8 = pcrDigest(fingerprint);
  console.log("certPCR8", certPCR8);
  if (certPCR8 !== pcr8) throw new Error("Invalid cert PCR8");
}