import WebSocket from "ws";
import { KIND_ADMIN, mainEnclave } from "./enclave";
import { Nip44 } from "./modules/nip44";
import { getPublicKey } from "nostr-tools";
import { finalizeEvent } from "./modules/nostr-tools";
import { mainParent } from "./parent";

// @ts-ignore
global.WebSocket ??= WebSocket;

const nip44 = new Nip44();

function mainTest(argv: string[]) {
  const url = argv[0];
  const privkey = Buffer.from(argv[1], "hex");
  const adminPubkey = argv[2];
  const ws = new WebSocket(url);
  return new Promise<void>((ok, err) => {
    ws.onopen = () => {
      const req = {
        id: "" + Date.now(),
        method: "import_key",
        params: [privkey.toString("hex")],
      };
      const event = finalizeEvent(
        {
          created_at: Math.floor(Date.now() / 1000),
          kind: KIND_ADMIN,
          content: nip44.encrypt(privkey, adminPubkey, JSON.stringify(req)),
          tags: [["p", adminPubkey]],
        },
        privkey
      );
      console.log("sending", event);
      const { id, pubkey, kind, created_at, content, tags, sig } = event;
      ws.send(
        JSON.stringify([
          "EVENT",
          { id, pubkey, kind, created_at, content, tags, sig },
        ])
      );
      ws.onmessage = (e) => {
        const data = JSON.parse(e.data as string);
        console.log("got data", data);
        if (data[0] === "OK" && data[1] === event.id) {
          if (data[2] === true) ok();
          else err("Failed to import");
        }
      };
    };
  });
}

async function main() {
  console.log(process.argv);
  const module = process.argv[2];
  const args = process.argv.slice(3);
  switch (module) {
    case "enclave":
      return mainEnclave(args);
    case "parent":
      return mainParent(args);
    case "test":
      return mainTest(args);
  }
}

// start
main();
