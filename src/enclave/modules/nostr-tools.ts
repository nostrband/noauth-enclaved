import {
  Event as EventNT,
  UnsignedEvent as UnsignedEventNT,
  generateSecretKey as generateSecretKeyNT,
  getPublicKey as getPublicKeyNT,
  finalizeEvent as finalizeEventNT,
  validateEvent as validateEventNT,
  verifyEvent as verifyEventNT,
  nip19 as nip19NT,
  Filter as FilterNT,
} from "nostr-tools";

export type Event = EventNT;
export type UnsignedEvent = UnsignedEventNT;
export type Filter = FilterNT;

export const getPublicKey = getPublicKeyNT;
export const generateSecretKey = generateSecretKeyNT;
export const finalizeEvent = finalizeEventNT;
export const validateEvent = validateEventNT;
export const verifyEvent = verifyEventNT;
export const nip19 = nip19NT;