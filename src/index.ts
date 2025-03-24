import WebSocket from "ws";
import { mainEnclave } from "./enclave";
import { mainParent } from "./parent";
import { nsmInit } from "./enclave/modules/nsm";
import { mainCli } from "./cli";

// @ts-ignore
global.WebSocket ??= WebSocket;

async function main() {
  console.log(process.argv);
  const module = process.argv[2];
  const args = process.argv.slice(3);
  switch (module) {
    case "enclave":
      return mainEnclave(args);
    case "parent":
      return mainParent(args);
    case "cli":
      return mainCli(args)
        .then(() => process.exit())
        .catch((e) => {
          console.error(e);
          process.exit(-1);
        });
  }
}

// start
main();
