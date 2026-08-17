/**
 * ⚠️ SCHEDULED TASKS ARE OFF.
 *
 * The feature is BUILT and the server half is deployed — the screens, the store,
 * the sheets, the API client and the block-level "add from this paragraph" flow
 * are all still here and still compile. What is switched off is every way IN:
 * the row under an assistant answer, the paragraph toolbar's ☑ button, and the
 * two screens themselves (which bounce back rather than render).
 *
 * Turned off 2026-08-17 to be reworked, not abandoned. Flip this to `true` to
 * restore all of it — nothing else needs editing, which is the whole point of
 * routing every entry point through one constant instead of deleting them.
 *
 * ⚠️ It also stops the Writer's 20-second poll for a live run. That poll is the
 * feature's only background cost, and leaving it running for a feature the
 * student cannot reach would be a network request every 20s for nothing.
 */
// `: boolean`, NOT the inferred `false` literal — otherwise TypeScript narrows
// every gate below to a dead branch and stops checking the code inside it, so the
// day this flips back to `true` a pile of type errors arrives at once. Typed wide,
// both states are checked on every run of `npx tsc --noEmit`.
export const TASKS_ENABLED: boolean = false;
