import { Event, UnsignedEvent } from "./nostr-tools";

export interface Signer {
  getPublicKey(): Promise<string>;

  signEvent(event: UnsignedEvent): Promise<Event>;

  nip04Encrypt(pubkey: string, data: string): Promise<string>;

  nip04Decrypt(pubkey: string, data: string): Promise<string>;

  nip44Encrypt(pubkey: string, data: string): Promise<string>;

  nip44Decrypt(pubkey: string, data: string): Promise<string>;
}

export interface Nip46Req {
  clientPubkey: string;
  id: string;
  method: string;
  params: string[];
}

export type Decision = "allow" | "disallow" | "ignore" | "ask";

export interface AttestationData {
  pcrs: Map<number, Uint8Array>;
  module_id: string;
}

export interface InstanceInfo {
  build?: Event;
  instance?: Event;
  instanceAnnounceRelays?: string[];
}

