import { sha384 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { X509Certificate } from "crypto";
import { Event, nip19 } from "./nostr-tools";
import { AttestationData } from "./types";

export function pcrDigest(data: Buffer | Uint8Array | string) {
  return bytesToHex(
    sha384
      .create()
      // https://github.com/aws/aws-nitro-enclaves-cli/issues/446#issuecomment-1460766038
      // > The PCR registers start in a known zero state and each extend operation does a hash between the previous state and the data. 
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

export function verifyBuild(att: AttestationData, build: Event) {
  const enclavePCR8 = Buffer.from(att.pcrs.get(8) || []).toString("hex");
  if (!enclavePCR8) throw new Error("Bad attestation, no PCR8");
  console.log("enclavePCR8", enclavePCR8);
  const buildPCR8 = build.tags.find(
    (t) => t.length > 1 && t[0] === "PCR8"
  )?.[1];
  if (!buildPCR8) throw new Error("No PCR8 in build");
  if (enclavePCR8 !== buildPCR8) throw new Error("No matching PCR8");

  // it's not enough to just match pcr8 bcs this value is static
  // in a build and anyone can observe it after an instance is 
  // launched and can commit to it by themselves and launch a new
  // instance of this build as if they built it. so we have to 
  // actually check that buildCert matches pcr8 and check that buildCert
  // content points to the build.pubkey
  const buildCert = build.tags.find(
    (t) => t.length > 1 && t[0] === "cert"
  )?.[1];
  if (!buildCert) throw new Error("No cert in build");

  // validate the cert is for build.pubkey and produces the expected pcr8
  validateBuildCert(buildCert, build.pubkey, enclavePCR8);
}

export function verifyInstance(att: AttestationData, instance: Event) {
  const enclavePCR4 = Buffer.from(att.pcrs.get(4) || []).toString("hex");
  if (!enclavePCR4) throw new Error("Bad attestation, no PCR4");
  console.log("enclavePCR4", enclavePCR4);
  const instancePCR4 = instance.tags.find(
    (t) => t.length > 1 && t[0] === "PCR4"
  )?.[1];
  if (!instancePCR4) throw new Error("No PCR4 in instance");
  console.log("instancePCR4", instancePCR4);
  if (instancePCR4 !== enclavePCR4) throw new Error("No matching PCR4");
  return true;
}
