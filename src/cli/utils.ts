import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { Event, Filter } from "../enclave/modules/nostr-tools";
import { Relay } from "../enclave/modules/relay";

const KIND_CONTACTS = 3;
const KIND_RELAYS = 10002;

const BLACKLISTED_RELAYS: string[] = [];

const OUTBOX_RELAYS = [
  "wss://relay.nostr.band/all",
  "wss://relay.primal.net",
  "wss://purplepag.es",
];

export async function fetchFromRelays(
  filter: Filter,
  relayUrls: string[],
  timeout = 10000
) {
  const relays = relayUrls.map((r) => new Relay(r));
  const reqs = relays.map(
    (r) =>
      new Promise<Event[]>((ok, err) => {
        const timer = setTimeout(() => err("Timeout"), timeout);
        r.req({
          id: bytesToHex(randomBytes(6)),
          fetch: true,
          filter,
          onEOSE(events) {
            clearTimeout(timer);
            ok(events);
          },
        });
      })
  );
  const results = await Promise.allSettled(reqs);
  for (const r of relays) r.dispose();
  const events = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<Event[]>).value)
    .flat();
  const ids = new Set<string>();
  const uniq = events.filter((e) => {
    const has = !ids.has(e.id);
    ids.add(e.id);
    return !has;
  });
  return uniq;
}

export function parseRelayEvents(events: Event[]) {
  const pubkeyRelays = new Map<
    string,
    {
      writeRelays: string[];
      readRelays: string[];
    }
  >();

  for (const e of events) {
    const pr = pubkeyRelays.get(e.pubkey) || {
      writeRelays: [],
      readRelays: [],
    };
    if (e.kind === KIND_RELAYS) {
      const filter = (mark: string) => {
        return e.tags
          .filter(
            (t) =>
              t.length >= 2 && t[0] === "r" && (t.length === 2 || t[2] === mark)
          )
          .map((t) => t[1]);
      };
      pr.writeRelays.push(...filter("write"));
      pr.readRelays.push(...filter("read"));
    } else {
      try {
        const relays = JSON.parse(e.content);
        for (const url in relays) {
          if (relays[url].write) pr.writeRelays.push(url);
          if (relays[url].read) pr.readRelays.push(url);
        }
      } catch {}
    }
    pubkeyRelays.set(e.pubkey, pr);
  }

  return pubkeyRelays;
}

export function prepareRelays(
  pubkeyRelays: Map<
    string,
    {
      writeRelays: string[];
      readRelays: string[];
    }
  >,
  maxRelaysPerPubkey: number,
  // addFallback = false
) {
  const prepare = (relays: string[], maxRelaysPerPubkey: number) => {
    // normalize
    const normal = relays
      // normalize urls
      .map((r) => {
        try {
          const u = new URL(r);
          if (u.protocol !== "wss:" && u.protocol !== "ws:") return undefined;
          if (u.hostname.endsWith(".onion")) return undefined;
          if (u.hostname === "localhost") return undefined;
          if (u.hostname === "127.0.0.1") return undefined;
          return u.href;
        } catch {}
      })
      // only valid ones
      .filter((u) => !!u)
      // remove bad relays and outbox
      .filter(
        (r) => !BLACKLISTED_RELAYS.includes(r!) && !OUTBOX_RELAYS.includes(r!)
      ) as string[];

    // dedup
    const uniq = [...new Set(normal)];

    // // prioritize good relays
    // const good = uniq.sort((a, b) => {
    //   const ga = GOOD_RELAYS.includes(a);
    //   const gb = GOOD_RELAYS.includes(b);
    //   if (ga == gb) return 0;
    //   return ga ? -1 : 1;
    // });

    // if (good.length > maxRelaysPerPubkey) good.length = maxRelaysPerPubkey;

    // if (addFallback) good.push(...FALLBACK_RELAYS);

    return uniq;
  };

  // sanitize and prioritize per pubkey
  for (const rs of pubkeyRelays.values()) {
    rs.readRelays = prepare(rs.readRelays, maxRelaysPerPubkey);
    rs.writeRelays = prepare(rs.writeRelays, maxRelaysPerPubkey);

    // NOTE: some people mistakenly mark all relays as write/read
    if (!rs.readRelays.length) rs.readRelays = rs.writeRelays;
    if (!rs.writeRelays.length) rs.writeRelays = rs.readRelays;
  }

  // merge and dedup all write/read relays
  return {
    write: [
      ...new Set([...pubkeyRelays.values()].map((pr) => pr.writeRelays).flat()),
    ],
    read: [
      ...new Set([...pubkeyRelays.values()].map((pr) => pr.readRelays).flat()),
    ],
  };
}

export async function fetchRelays(
  pubkeys: string[],
  maxRelaysPerPubkey: number = 10,
  // addFallback = false
) {
  const events = await fetchFromRelays(
    {
      kinds: [KIND_CONTACTS, KIND_RELAYS],
      authors: pubkeys,
    },
    OUTBOX_RELAYS,
    10000
  );
  const pubkeyRelays = parseRelayEvents(events);

  // console.log("relays", events, pubkeyRelays);

  const relays = prepareRelays(pubkeyRelays, maxRelaysPerPubkey); // addFallback
  return {
    ...relays,
    // return all events too to let client cache them
    events: [...events],
  };
}

export async function fetchOutboxRelays(pubkeys: string[]) {
  return (await fetchRelays(pubkeys)).write;
}