/**
 * ElevenLabs Scribe v2 batch price for every plan including the free tier —
 * https://elevenlabs.io/pricing/api, read on 2026-08-27. Only the pre-flight estimate uses it.
 */
export const SCRIBE_USD_PER_HOUR = 0.22;
/** Keyterm prompting is billed as a surcharge on the base transcription. */
export const KEYTERMS_SURCHARGE = 0.2;

export function estimateScribeCostUsd(durationS: number, keytermCount = 0): number {
  const base = (Math.max(0, durationS) / 3600) * SCRIBE_USD_PER_HOUR;
  const total = keytermCount > 0 ? base * (1 + KEYTERMS_SURCHARGE) : base;
  return Math.round(total * 100) / 100;
}
