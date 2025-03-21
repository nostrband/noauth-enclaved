import { getRandom, open, getAttestationDoc } from "aws-nitro-enclaves-nsm-node";
import { decode } from "cbor2";

let fd: number;

export function nsmInit() {
  if (process.env.ENCLAVED !== "true") return;

  fd = open();

  // make sure all @noble code uses Nitro RNG
  global.crypto.getRandomValues = (array) => {
    if (!(array instanceof Int8Array || array instanceof Uint8Array || array instanceof Int16Array || array instanceof Uint16Array || array instanceof Int32Array || array instanceof Uint32Array || array instanceof Uint8ClampedArray)) {
      throw new Error('Expected an integer array')
    }
  
    if (array.byteLength > 256) {
      throw new Error('Can only request a maximum of 256 bytes')
    }

    const buf = getRandom(fd!);
    const dest = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    dest.set(new Uint8Array(buf).slice(0, array.byteLength));
//    console.log("random", Buffer.from(dest).toString("hex"), "from", buf.toString("hex"));

    return array;
  }    
}

export function nsmGetAttestation(pubkey: string) {
  if (!fd) return "";

  return getAttestationDoc(
    fd,
    null,
    null,
    Buffer.from(pubkey, "hex")
  );
}

export function nsmParseAttestation(att: Buffer) {
  const COSE_Sign1: Uint8Array[] = decode(att);
  console.log("COSE_Sign1", COSE_Sign1);
  if (COSE_Sign1.length !== 4) throw new Error("Bad attestation");

  const payload: any = decode(COSE_Sign1[2]);
  console.log("payload", payload);

  const { pcrs, module_id } = payload;
  return {
    pcrs,
    module_id
  }
}


