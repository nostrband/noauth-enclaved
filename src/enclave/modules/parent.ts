import { Event } from "./nostr-tools";
import { AttestationData } from "./types";
import { validateBuildCert } from "./utils";

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

