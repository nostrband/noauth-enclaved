// run ASAP to override crypto.getRandomValues
nsmInit();

import { startEnclave } from ".";
import { nsmInit } from "./modules/nsm";

// used to launch the process inside the enclave
const proxyUrl = process.argv[2];
const relayUrl = process.argv?.[3] || "wss://relay.nsec.app";
startEnclave({ proxyUrl, relayUrl });
