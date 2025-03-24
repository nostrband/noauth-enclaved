import os from "node:os";
import fs from "node:fs";
import { bytesToHex } from "@noble/hashes/utils";
import {
  KIND_ADMIN,
  KIND_INSTANCE,
  KIND_BUILD,
  REPO,
} from "../enclave/modules/consts";
import { nip19 } from "../enclave/modules/nostr-tools";
import readline from "node:readline";
import { Nip46Client } from "./nip46-client";
import { now } from "../enclave/modules/utils";
import { fetchOutboxRelays } from "./utils";
import { Relay } from "../enclave/modules/relay";

async function importKey({
  relayUrl,
  adminPubkey,
}: {
  relayUrl: string;
  adminPubkey: string;
}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  const privkeyHex = await new Promise<string>((ok) => {
    rl.on("line", (line) => {
      line = line.trim();
      if (line.startsWith("nsec1")) {
        const { type, data } = nip19.decode(line);
        if (type !== "nsec") throw new Error("Invalid nsec");
        line = bytesToHex(data);
      }
      console.log("privkey", line);
      ok(line);
    });
  });

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

export async function publishBuild({
  prod_dev,
  safe_unsafe,
  comment,
}: {
  prod_dev: string;
  safe_unsafe: string;
  comment: string;
}) {
  if (prod_dev !== "dev" && prod_dev !== "prod")
    throw new Error("Specify 'dev' or 'prod'");
  if (safe_unsafe !== "safe" && safe_unsafe !== "unsafe")
    throw new Error("Specify 'safe' or 'unsafe'");

  const npub = fs.readFileSync("./build/npub.txt").toString("utf8").trim();
  console.log("npub", npub);
  const { type, data: pubkey } = nip19.decode(npub);
  if (type !== "npub") throw new Error("Invalid npub");

  const docker = JSON.parse(
    fs.readFileSync("./build/docker.json").toString("utf8")
  );
  console.log("docker info", docker);

  const pcrs = JSON.parse(
    fs.readFileSync("./build/pcrs.json").toString("utf8")
  );
  console.log("pcrs", pcrs);

  const cert = fs
    .readFileSync("./build/crt.pem")
    .toString("utf8")
    .split("\n")
    .filter((s) => !s.startsWith("--"))
    .join()
    .trim();
  console.log("cert", cert);

  const pkg = JSON.parse(fs.readFileSync("package.json").toString("utf8"));
  console.log("pkg", pkg);

  console.log("signing in as", pubkey);
  const client = new Nip46Client({
    relayUrl: "wss://relay.nsec.app",
    filename: os.homedir() + "/.noauth-enclaved-cli.json",
    perms: `sign_event:${KIND_INSTANCE}`,
  });
  await client.start();
  const authPubkey = await client.getPublicKey();
  console.log("signed in as", authPubkey);
  if (authPubkey !== pubkey) throw new Error("Wrong auth npub");

  const relays = await fetchOutboxRelays([pubkey]);
  console.log("relays", relays);

  const unsigned = {
    created_at: now(),
    kind: KIND_BUILD,
    content: comment,
    pubkey: await client.getPublicKey(),
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
  const event = await client.signEvent(unsigned);
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

      const prod_dev = argv[1];
      const safe_unsafe = argv[2];
      const comment = argv[3] || "";
      return publishBuild({
        prod_dev,
        safe_unsafe,
        comment,
      });
    }
  }
}
