import fs from "node:fs";
import { SocksProxyAgent } from "socks-proxy-agent";
import { Event, finalizeEvent, getPublicKey } from "./nostr-tools";
import { nsmGetAttestation, nsmParseAttestation } from "./nsm";
import { ANNOUNCEMENT_INTERVAL, KIND_INSTANCE, REPO } from "./consts";
import { now } from "./utils";
import { bytesToHex } from "@noble/hashes/utils";
import { Relay } from "./relay";

export function startAnnouncing({
  agent,
  build,
  instance,
  privkey,
  inboxRelayUrl,
  instanceAnnounceRelays = [],
}: {
  agent: SocksProxyAgent;
  build?: Event;
  instance?: Event;
  privkey: Uint8Array;
  inboxRelayUrl: string;
  instanceAnnounceRelays?: string[];
}) {
  const announce = async () => {
    const pubkey = getPublicKey(privkey);
    const attestation = nsmGetAttestation(pubkey);
    console.log("attestation", attestation);
    if (!attestation) throw new Error("Failed to get attestation");

    const pkg = JSON.parse(fs.readFileSync("package.json").toString("utf8"));
    console.log("pkg", pkg);

    const { pcrs, module_id } = nsmParseAttestation(attestation);

    /**
https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html
PCR0	Enclave image file	A contiguous measure of the contents of the image file, without the section data.
PCR1	Linux kernel and bootstrap	A contiguous measurement of the kernel and boot ramfs data.
PCR2	Application	A contiguous, in-order measurement of the user applications, without the boot ramfs.
PCR3	IAM role assigned to the parent instance	A contiguous measurement of the IAM role assigned to the parent instance. Ensures that the attestation process succeeds only when the parent instance has the correct IAM role.
PCR4	Instance ID of the parent instance	A contiguous measurement of the ID of the parent instance. Ensures that the attestation process succeeds only when the parent instance has a specific instance ID.
PCR8	Enclave image file signing certificate	A measure of the signing certificate specified for the enclave image file. Ensures that the attestation process succeeds only when the enclave was booted from an enclave image file signed by a specific certificate.
     */

    const signed = finalizeEvent(
      {
        kind: KIND_INSTANCE,
        created_at: now(),
        content: attestation.toString("base64"),
        tags: [
          ["r", REPO],
          ["name", pkg.name],
          ["v", pkg.version],
          ["m", module_id],
          // we don't use PCR3
          ...[0, 1, 2, 4, 8].map((id) => [
            "x",
            bytesToHex(pcrs.get(id)!),
            `PCR${id}`,
          ]),
          ["build", build ? JSON.stringify(build) : ""],
          ["instance", instance ? JSON.stringify(instance) : ""],
          // admin interface relay with spam protection
          ["relay", inboxRelayUrl],
          // expires in 3 hours, together with attestation doc
          ["expiration", "" + (now() + 3 * 3600)],
          ["alt", "noauth-enclaved instance"],
        ],
      },
      privkey
    );
    console.log("announcement", signed);
    const relays = [...instanceAnnounceRelays];
    if (!relays.length)
      relays.push(
        ...[
          "wss://relay.nostr.band/",
          "wss://relay.damus.io",
          "wss://relay.primal.net",
        ]
      );

    try {
      const promises = relays.map((url) => {
        const r = new Relay(url, agent);
        return r.publish(signed).finally(() => r.dispose());
      });

      const results = await Promise.allSettled(promises);
      if (!results.find((r) => r.status === "fulfilled"))
        throw new Error("Failed to announce");

      // schedule next announcement
      setTimeout(announce, ANNOUNCEMENT_INTERVAL);
    } catch (e) {
      console.log("Failed to announce", e);

      // retry faster than normal
      setTimeout(announce, ANNOUNCEMENT_INTERVAL / 10);
    }
  };
  announce();
}
