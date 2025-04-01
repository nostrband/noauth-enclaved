import { verifyBuild, verifyInstance } from "./aws";
import { nsmGetAttestation, nsmParseAttestation } from "./nsm";
import { InstanceInfo } from "./types";

export async function getInfo(parentUrl: string) {
  // get build and instance info from the enclave parent
  // and verify that info matches our own attestation
  const ws = new WebSocket(parentUrl);
  const reply = await new Promise<InstanceInfo | null>((ok, err) => {
    ws.onopen = () => {
      const att = nsmGetAttestation();
      if (!att) {
        ok({});
        return;
      }
      const attData = nsmParseAttestation(att);
      ws.send(
        JSON.stringify({
          id: "start",
          method: "start",
          params: [att.toString("base64")],
        })
      );
      // return null to retry on timeout
      const timer = setTimeout(() => ok(null), 10000);
      ws.onmessage = (ev) => {
        clearTimeout(timer);
        const data = ev.data.toString("utf8");
        try {
          const r = JSON.parse(data);
          if (r.id !== "start") throw new Error("Bad reply id");
          if (r.error) throw new Error(r.error);
          const { build, instance, instanceAnnounceRelays, prod } = JSON.parse(
            r.result
          );
          if (!build || !instance) throw new Error("Bad reply");

          const notDebug = !!attData.pcrs.get(0)!.find((c) => c !== 0);
          if (notDebug) {
            verifyBuild(attData, build);
            verifyInstance(attData, instance);
          }
          console.log(
            new Date(),
            "got valid build and instance info",
            build,
            instance
          );
          ok({ build, instance, instanceAnnounceRelays, prod });
        } catch (e: any) {
          console.log("parent reply error", e, data);
          err(e.message || e.toString());
        }
      };
    };
  });
  if (reply === null) {
    // pause and retry
    console.log(new Date(), "Failed to get info from parent, will retry...");
    await new Promise((ok) => setTimeout(ok, 3000));
    return getInfo(parentUrl);
  } else {
    return reply;
  }
}
