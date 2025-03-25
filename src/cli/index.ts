import os from "node:os";
import fs from "node:fs";
import { bytesToHex } from "@noble/hashes/utils";
import {
  KIND_ADMIN,
  KIND_INSTANCE,
  KIND_BUILD,
  REPO,
  KIND_BUILD_SIGNATURE,
} from "../enclave/modules/consts";
import {
  nip19,
  validateEvent,
  verifyEvent,
} from "../enclave/modules/nostr-tools";
import readline from "node:readline";
import { Nip46Client } from "./nip46-client";
import { now, pcrDigest } from "../enclave/modules/utils";
import { fetchOutboxRelays, rawEvent } from "./utils";
import { Relay } from "../enclave/modules/relay";
import { Signer } from "../enclave/modules/types";
import { sha384 } from "@noble/hashes/sha2";

async function readLine() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  return await new Promise<string>((ok) => {
    rl.on("line", (line) => {
      ok(line);
    });
  });
}

async function importKey({
  relayUrl,
  adminPubkey,
}: {
  relayUrl: string;
  adminPubkey: string;
}) {
  console.log("Enter nsec:");
  let line = await readLine();
  line = line.trim();
  if (line.startsWith("nsec1")) {
    const { type, data } = nip19.decode(line);
    if (type !== "nsec") throw new Error("Invalid nsec");
    line = bytesToHex(data);
  }
  const privkeyHex = line;
  console.log("privkey", privkeyHex);

  const privkey = Buffer.from(privkeyHex, "hex");
  if (privkey.length !== 32) throw new Error("Invalid privkey");

  const client = new Nip46Client({
    relayUrl,
    kind: KIND_ADMIN,
    signerPubkey: adminPubkey,
    privkey,
  });
  await client.start();

  const reply = await client.send({
    method: "import_key",
    params: [privkey.toString("hex")],
  });

  if (reply !== "ok") throw new Error("Invalid reply");
  console.log("Key imported to enclave");
}

function readCert(dir: string) {
  return fs
    .readFileSync(dir + "/crt.pem")
    .toString("utf8")
    .split("\n")
    .filter((s) => !s.startsWith("--"))
    .join("")
    .trim();
}

function readPubkey(dir: string) {
  const npub = fs
    .readFileSync(dir + "/npub.txt")
    .toString("utf8")
    .trim();
  console.log("npub", npub);
  if (!npub) throw new Error("No pubkey")
  const { type, data: pubkey } = nip19.decode(npub);
  if (type !== "npub") throw new Error("Invalid npub");
  return pubkey;  
}

async function createSigner(pubkey: string): Promise<Signer> {
  const client = new Nip46Client({
    relayUrl: "wss://relay.nsec.app",
    filename: os.homedir() + "/.noauth-enclaved-cli.json",
    perms: `sign_event:${KIND_INSTANCE}`,
  });
  await client.start();
  const authPubkey = await client.getPublicKey();
  console.log("signed in as", authPubkey);
  if (authPubkey !== pubkey) throw new Error("Wrong auth npub");
  return client;
}

export async function publishBuild({
  dir,
  prod_dev,
  safe_unsafe,
  comment,
}: {
  dir: string;
  prod_dev: string;
  safe_unsafe: string;
  comment: string;
}) {
  if (prod_dev !== "dev" && prod_dev !== "prod")
    throw new Error("Specify 'dev' or 'prod'");
  if (safe_unsafe !== "safe" && safe_unsafe !== "unsafe")
    throw new Error("Specify 'safe' or 'unsafe'");

  const pubkey = readPubkey(dir);
  console.log("pubkey", pubkey);

  const docker = JSON.parse(
    fs.readFileSync(dir + "/docker.json").toString("utf8")
  );
  console.log("docker info", docker);

  const pcrs = JSON.parse(
    fs.readFileSync(dir+"/pcrs.json").toString("utf8")
  );
  console.log("pcrs", pcrs);

  const cert = readCert(dir);
  console.log("cert", cert);

  const pkg = JSON.parse(fs.readFileSync("package.json").toString("utf8"));
  console.log("pkg", pkg);

  console.log("signing in as", pubkey);
  const signer = await createSigner(pubkey);

  const relays = await fetchOutboxRelays([pubkey]);
  console.log("relays", relays);

  const unsigned = {
    created_at: now(),
    kind: KIND_BUILD,
    content: comment,
    pubkey: await signer.getPublicKey(),
    tags: [
      ["r", REPO],
      ["name", pkg.name],
      ["v", pkg.version],
      ["t", prod_dev],
      ["t", safe_unsafe],
      ["cert", cert],
      ["x", docker["containerimage.config.digest"], "docker.config"],
      ["x", docker["containerimage.digest"], "docker.manifest"],
      ...[0, 1, 2, 8]
        .map((id) => `PCR${id}`)
        .map((pcr) => ["x", pcrs.Measurements[pcr], pcr]),
    ],
  };
  // console.log("signing", unsigned);
  const event = await signer.signEvent(unsigned);
  console.log("signed", event);

  const res = await Promise.allSettled(
    relays.map((url) => {
      const r = new Relay(url);
      return r.publish(event).finally(() => r.dispose());
    })
  );

  console.log(
    "published to",
    res.filter((r) => r.status === "fulfilled").length
  );
}

async function signBuild(dir: string) {
  const pubkey = readPubkey(dir);
  console.log("pubkey", pubkey);

  const pcrs = JSON.parse(fs.readFileSync(dir + "/pcrs.json").toString("utf8"));
  console.log("pcrs", pcrs);

  const cert = readCert(dir);
  console.log("cert", cert);

  const signer = await createSigner(pubkey);

  // PCR8 is unique on every build (the way we do the build)
  // so reuse of this event is impossible
  const unsigned = {
    created_at: now(),
    kind: KIND_BUILD_SIGNATURE,
    content: "",
    pubkey: await signer.getPublicKey(),
    tags: [
      ["-"], // not for publishing
      ["expiration", "" + (now() - 1000)], // expired
      ["cert", cert],
      ["PCR8", pcrs.Measurements["PCR8"]],
    ],
  };
  console.log("signing", unsigned);
  const event = await signer.signEvent(unsigned);
  console.log("signed", event);

  fs.writeFileSync(dir + "/build.json", JSON.stringify(rawEvent(event)));
}

async function ensureInstanceSignature(dir: string) {
  const pubkey = readPubkey(dir);
  console.log("pubkey", pubkey);

  try {
    const event = JSON.parse(fs.readFileSync(dir + "/instance.json").toString("utf8"));
    console.log("sig event", event);
    if (!validateEvent(event) || !verifyEvent(event))
      throw new Error("Invalid event");
    if (event.pubkey !== pubkey) throw new Error("Invalid event pubkey");
    console.log("Have valid instance signature");
    return;
  } catch (e) {
    console.log("No instance signature", e);
  }

  console.log("Enter instance ID:");
  const line = (await readLine()).trim();
  if (!line.startsWith("i-") || line.includes(" "))
    throw new Error("Invalid instance id " + line);

  // AWS ensure EC2 instance IDs are unique and will never be reused,
  // so reusing this event on another instance won't work bcs
  // enclave's PCR4 will not match the one below
  const instanceId = line;
  console.log("instance", instanceId);
  // https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html#pcr4
  const pcr4 = pcrDigest(instanceId);
  console.log("pcr4", pcr4);

  const signer = await createSigner(pubkey);

  const unsigned = {
    created_at: now(),
    kind: KIND_BUILD_SIGNATURE,
    content: "",
    pubkey: await signer.getPublicKey(),
    tags: [
      ["-"], // not for publishing
      ["expiration", "" + (now() - 1000)], // expired
      ["PCR4", pcr4],
    ],
  };
  console.log("signing", unsigned);
  const event = await signer.signEvent(unsigned);
  console.log("signed", event);

  fs.writeFileSync(dir + "/instance.json", JSON.stringify(rawEvent(event)));
}

async function verifyBuild() {}

export function mainCli(argv: string[]) {
  if (!argv.length) throw new Error("Command not specified");

  const method = argv[0];
  switch (method) {
    case "import_key": {
      const relayUrl = argv[1];
      const adminPubkey = argv[2];
      return importKey({ relayUrl, adminPubkey });
    }
    case "sign_build": {
      const dir = argv?.[1] || "./build/";
      return signBuild(dir);
    }
    case "ensure_instance_signature": {
      const dir = argv?.[1] || "./instance/";
      return ensureInstanceSignature(dir);
    }
    case "publish_build": {
      // docker config/manifest hashes taken from build/docker.json
      // pcrs taken from build/pcrs.json
      // crt.pem taken from build/crt.pem
      // npub must be written to build/npub.txt
      //
      // need info:
      // - prod/dev flag
      // - safe/unsafe flag
      // - comment

      // FIXME make it adjustible
      const dir = "./build/";
      const prod_dev = argv[1];
      const safe_unsafe = argv[2];
      const comment = argv[3] || "";
      return publishBuild({
        dir,
        prod_dev,
        safe_unsafe,
        comment,
      });
    }
    default: {
      throw new Error("Unknown command");
    }
  }
}
