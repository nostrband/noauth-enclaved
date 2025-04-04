import { open, getAttestationDoc } from "aws-nitro-enclaves-nsm-node";
import { decode } from "cbor2";
import { AttestationData } from "./types";

let fd: number;

export function nsmInit() {
  fd = open();

  // looks like this is unnecessary and modern kernels
  // and enclave VMs integrate the nsm rng into
  // the OS

  // // make sure all @noble code uses Nitro RNG
  // global.crypto.getRandomValues = (array) => {
  //   if (
  //     !(
  //       array instanceof Int8Array ||
  //       array instanceof Uint8Array ||
  //       array instanceof Int16Array ||
  //       array instanceof Uint16Array ||
  //       array instanceof Int32Array ||
  //       array instanceof Uint32Array ||
  //       array instanceof Uint8ClampedArray
  //     )
  //   ) {
  //     throw new Error("Expected an integer array");
  //   }

  //   if (array.byteLength > 256) {
  //     throw new Error("Can only request a maximum of 256 bytes");
  //   }

  //   const buf = getRandom(fd!);
  //   const dest = new Uint8Array(
  //     array.buffer,
  //     array.byteOffset,
  //     array.byteLength
  //   );
  //   dest.set(new Uint8Array(buf).slice(0, array.byteLength));
  //   //    console.log("random", Buffer.from(dest).toString("hex"), "from", buf.toString("hex"));

  //   return array;
  // };
}

export function nsmGetAttestation(pubkey?: string) {
  if (!fd) return "";

  return getAttestationDoc(
    fd,
    null, // user data
    null, // nonce
    pubkey ? Buffer.from(pubkey, "hex") : null
  );
}

export function nsmParseAttestation(att: Buffer) {
  const COSE_Sign1: Uint8Array[] = decode(att);
  console.log("COSE_Sign1", COSE_Sign1);
  if (COSE_Sign1.length !== 4) throw new Error("Bad attestation");

  const data: AttestationData = decode(COSE_Sign1[2]);
  console.log("data", data);
  return data;
}
