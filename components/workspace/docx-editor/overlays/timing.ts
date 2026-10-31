// The two clocks of the local range apply (host → DOM → host), shared by both sides.
//
// ⚠️ They are a pair. The host gives up waiting after RANGE_APPLY_WAIT_MS and sends
// the passage to the SERVER; the DOM refuses a request older than RANGE_APPLY_TTL_MS.
// If the DOM could still act on a request the host had already given up on, the
// passage would be applied twice — once locally (and saved), once by the server on
// top. Keep TTL well below WAIT (the gap is the reply's own trip back).

/** The DOM ignores a range-apply request older than this. */
export const RANGE_APPLY_TTL_MS = 2500;
/** The host stops waiting for the DOM's answer after this, and goes to the server. */
export const RANGE_APPLY_WAIT_MS = 6000;
/** How long a server-path "applying" preview may stay up if no reload ever lands. */
export const APPLYING_MAX_MS = 15000;
