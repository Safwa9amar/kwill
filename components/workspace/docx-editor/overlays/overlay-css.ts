// The overlay cards' stylesheet. A port of the Lexical inline-suggestion CSS
// (components/workspace/lexical/editor-components/styles/suggestion.ts + motion.ts +
// tables.ts) with the `lx-` prefix renamed `kwo-`, so the student sees the same card
// on both surfaces. Same fixed on-white palette: the cards sit on the white page.
//
// ⚠️ font-family is the GENERIC `sans-serif` keyword on purpose: in a WebView a
// concrete-first stack does not fall back to the system Arabic font and renders
// tofu (memory: webview-arabic-font). Buttons and inputs do not inherit the page
// font, so each says `font: inherit`.
//
// The accent (✦ marks) comes from the host as a CSS variable, `--kwo-accent`.

export const OVERLAY_CSS = `
.kwo-layer { font-family: sans-serif; }
.kwo-card { position: fixed; will-change: transform; z-index: 1000; box-sizing: border-box; background: #fff; border: 1px solid #E8ECEF;
  border-radius: 16px; box-shadow: 0 10px 28px -8px rgba(10,30,20,.28); padding: 10px 12px 4px; overflow-y: auto;
  -webkit-overflow-scrolling: touch; color: #16171d; font-family: sans-serif; font-size: 15px; line-height: 1.7;
  text-align: start; animation: kwo-in 240ms cubic-bezier(0.33, 1, 0.68, 1) both; }
.kwo-card button, .kwo-card textarea, .kwo-card input, .kwo-chip button { font: inherit; }
/* instruction chip */
.kwo-sug-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 92%; margin: 2px 0 6px; padding: 3px 10px; border-radius: 999px; background: rgba(14,122,70,.08); border: 1px solid rgba(14,122,70,.18); color: #0E5C36; font-size: 11px; font-weight: 600; line-height: 1.4; }
.kwo-sug-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* "Thought for Xs" trace */
.kwo-sug-trace { margin: 0 0 6px; border: 1px solid #D4DAE1; border-radius: 10px; background: #fff; padding: 4px 10px; }
.kwo-sug-trace > summary { list-style: none; cursor: pointer; font-size: 11.5px; font-weight: 600; color: #0E5C36; }
.kwo-sug-trace > summary::-webkit-details-marker { display: none; }
.kwo-sug-trace-body { margin-top: 6px; font-size: 12px; line-height: 1.55; color: #3C4654; white-space: pre-wrap; max-height: 160px; overflow-y: auto; }
/* proposed text = the paragraph */
.kwo-sug-proposed { font-size: 15px; line-height: 1.7; color: #16171d; border-inline-start: 3px solid #22C07A; padding-inline-start: 10px; white-space: pre-wrap; }
.kwo-sug-proposed.kwo-sug-loading { opacity: .38; position: relative; overflow: hidden; }
.kwo-applying-inner { position: relative; overflow: hidden; }
.kwo-sug-proposed.kwo-sug-loading::after, .kwo-applying-inner::after { content: ""; position: absolute; top: 0; bottom: 0; width: 55%; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.9), transparent); animation: kwo-sweep 1.4s linear infinite; pointer-events: none; }
/* range rewrite: a passage, one bar per paragraph */
.kwo-sug-passage { display: flex; flex-direction: column; gap: 8px; }
.kwo-sug-ppara { margin: 0; }
.kwo-sug-prow { display: flex; align-items: flex-start; gap: 6px; }
.kwo-sug-prow .kwo-sug-proposed { flex: 1 1 auto; min-width: 0; }
.kwo-sug-dropped { opacity: .45; text-decoration: line-through; text-decoration-color: #C0392B; border-inline-start-color: #C0392B; }
.kwo-sug-toggle { flex: 0 0 auto; width: 26px; height: 26px; border: none; border-radius: 7px; background: transparent; color: #8A94A4; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0; }
.kwo-sug-toggle:active { transform: scale(.9); }
.kwo-sug-toggle.on { color: #C0392B; }
.kwo-sug-add { background: rgba(34,192,122,.18); border-radius: 3px; animation: kwo-addflash 700ms ease-out both; }
/* original teaser (tap to expand; del-marks when open) */
.kwo-sug-teaser { margin-top: 8px; padding: 6px 9px; background: #F6F8FA; border-radius: 8px; cursor: pointer; }
.kwo-sug-teaser-txt { font-size: 12.5px; line-height: 1.5; color: #8A94A4; }
.kwo-sug-teaser-txt.kwo-sug-clamp { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.kwo-sug-del { background: #FDECEC; color: #B3564A; text-decoration: line-through; border-radius: 3px; }
/* error slip */
.kwo-sug-err { margin-top: 8px; padding: 8px 10px; background: #FDF0EF; border: 1px solid rgba(192,57,43,.25); border-radius: 8px; color: #C0392B; font-size: 12.5px; font-weight: 500; line-height: 1.45; }
/* edit-in-place textarea */
.kwo-sug-edit { width: 100%; box-sizing: border-box; font-size: 15px; line-height: 1.7; color: #16171d; border: 1px solid #D4DAE1; border-radius: 8px; padding: 8px 10px; resize: vertical; min-height: 96px; background: #fff; }
/* the floating action pill */
/* The actions are a STICKY FOOTER: a long proposal scrolls inside the card and
   Apply/Again/Reject stay in reach instead of waiting at the end of it (user,
   10-31). Bleeds over the card's side/bottom padding (12px / 4px) so the white
   fade covers the text scrolling under it. */
.kwo-sug-pill { display: flex; justify-content: center; position: sticky; bottom: -4px; z-index: 2; margin: 4px -12px -4px; padding: 16px 12px 10px; background: linear-gradient(to bottom, rgba(255,255,255,0), #fff 45%); animation: kwo-in 300ms cubic-bezier(0.33, 1, 0.68, 1) both; }
.kwo-sug-pillrow { display: inline-flex; align-items: center; gap: 2px; background: #fff; border: 1px solid #E8ECEF; border-radius: 999px; padding: 4px; box-shadow: 0 5px 12px -2px rgba(10,30,20,.16); }
.kwo-sug-approve { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 96px; padding: 8px 16px; border: 1px solid rgba(14,122,70,.18); border-radius: 999px; background: rgba(14,122,70,.12); color: #0E5C36; font-size: 12.5px; font-weight: 600; cursor: pointer; line-height: 1.2; }
.kwo-sug-approve:active { background: rgba(14,122,70,.24); }
.kwo-sug-approve:disabled { opacity: .5; }
.kwo-sug-icon { display: inline-flex; align-items: center; justify-content: center; padding: 8px 10px; border: none; border-radius: 999px; background: transparent; color: #3C4654; cursor: pointer; }
.kwo-sug-icon:active { background: rgba(60,70,84,.10); }
.kwo-sug-icon.kwo-sug-danger { color: #C0392B; }
.kwo-sug-approve, .kwo-sug-icon { transition: transform 120ms ease, background 120ms ease; }
.kwo-sug-approve:active, .kwo-sug-icon:active { transform: scale(0.92); }
.kwo-sug-think { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; color: #0E5C36; font-size: 12px; font-weight: 500; }
.kwo-sug-think svg { animation: kwo-spin 1s linear infinite; transform-origin: center; }
/* "still working" note */
.kwo-working { display: flex; align-items: center; gap: 8px; font-size: 11.5px; line-height: 1.45; color: #6b7280; margin: 4px 0 2px; }
.kwo-working > span:first-child { flex: 1 1 auto; }
.kwo-working > span:last-child { flex: 0 0 auto; font-variant-numeric: tabular-nums; opacity: .85; }
/* the brand ✦ chip heading table proposals */
.kwo-aichip { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--kwo-accent-ink, #C2670C); background: var(--kwo-accent-wash, #FEF3E6); border: none; border-radius: 999px; padding: 3px 10px; margin-bottom: 4px; line-height: 1.4; }
.kwo-tracebox { max-height: 84px; overflow-y: auto; border: 1px solid #e4e4ea; border-radius: 8px; padding: 6px 10px; font-size: 11.5px; line-height: 1.5; color: #6b7280; font-style: italic; white-space: pre-wrap; }
.kwo-pillbtn { border-radius: 999px; padding: 5px 14px; border: 1px solid #d4d4dc; background: #fff; color: #222; cursor: pointer; font-size: 12px; line-height: 1.3; }
.kwo-pillbtn.ok { background: #16a34a; border-color: #16a34a; color: #fff; }
.kwo-pillbtn.no { background: #fff1f1; border-color: #fca5a5; color: #b91c1c; }
.kwo-tblscroll { overflow-x: auto; max-width: 100%; -webkit-overflow-scrolling: touch; padding-bottom: 10px; }
.kwo-tblscroll::-webkit-scrollbar { height: 4px; }
.kwo-tblscroll::-webkit-scrollbar-track { background: transparent; }
.kwo-tblscroll::-webkit-scrollbar-thumb { background: #33D6A6; border-radius: 999px; }
.kwo-tbl-loading { pointer-events: none; animation: kwo-tblpulse 1.1s ease-in-out infinite alternate; }
/* a pending table request: the real table dims under a white veil */
.kwo-veil { position: fixed; will-change: transform; z-index: 999; background: rgba(255,255,255,.55); border-radius: 6px; pointer-events: none; animation: kwo-tblpulse 1.1s ease-in-out infinite alternate; }
.kwo-strip { position: fixed; will-change: transform; z-index: 1000; box-sizing: border-box; display: flex; align-items: center; gap: 8px; border: 1px solid #fca5a5; background: #fff1f1; border-radius: 10px; padding: 6px 10px; font-family: sans-serif; }
/* what the student approved, painted over its place while the server applies it */
.kwo-applying-label { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; color: #0E5C36; margin-bottom: 2px; }
.kwo-applying-label svg { animation: kwo-spin 1s linear infinite; }
/* the completion chip (D11: a floating "continue…" under the caret) */
.kwo-chip { position: fixed; will-change: transform; z-index: 1000; box-sizing: border-box; display: flex; align-items: flex-start; gap: 6px; max-width: calc(100vw - 16px); background: #fff; border: 1px solid #E8ECEF; border-radius: 14px; box-shadow: 0 6px 18px -6px rgba(10,30,20,.25); padding: 6px 6px 6px 10px; font-family: sans-serif; animation: kwo-in 200ms cubic-bezier(0.33, 1, 0.68, 1) both; }
.kwo-chip-text { flex: 1 1 auto; min-width: 0; color: #6b7280; font-size: 14px; line-height: 1.5; cursor: pointer; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.kwo-chip-text b { color: var(--kwo-accent, #F59433); font-weight: 700; margin-inline-end: 4px; }
.kwo-chip .kwo-sug-icon { padding: 6px 8px; }
/* motion */
@keyframes kwo-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
@keyframes kwo-sweep { from { transform: translateX(-140%); } to { transform: translateX(320%); } }
@keyframes kwo-spin { to { transform: rotate(360deg); } }
@keyframes kwo-addflash { 0% { background: rgba(34, 192, 122, 0.5); } 100% { background: rgba(34, 192, 122, 0.18); } }
@keyframes kwo-tblpulse { from { opacity: 0.35; } to { opacity: 0.65; } }
/* The host's applying preview takes over from a card that was already showing the
   same thing: no entrance, no hit area (the page under it still scrolls), and a
   fade once the reload carrying the real result has landed. An opacity CLASS would
   lose to the entrance animation's fill-mode, hence an animation for the fade too. */
.kwo-card.kwo-still { animation: none; pointer-events: none; }
.kwo-card.kwo-still.kwo-gone { animation: kwo-out 180ms ease forwards; }
@keyframes kwo-out { to { opacity: 0; } }
.kwo-card.kwo-leaving-reject { animation: kwo-reject-out 200ms cubic-bezier(0.4, 0, 1, 1) forwards; }
@keyframes kwo-reject-out { to { opacity: 0; transform: translateY(10px) rotate(0.6deg); } }
@media (prefers-reduced-motion: reduce) {
  .kwo-card, .kwo-sug-pill, .kwo-chip, .kwo-sug-add, .kwo-sug-think svg, .kwo-applying-label svg, .kwo-veil, .kwo-tbl-loading { animation: none; }
  .kwo-sug-proposed.kwo-sug-loading::after, .kwo-applying-inner::after { animation: none; }
  .kwo-card.kwo-leaving-reject, .kwo-card.kwo-still.kwo-gone { animation: none; opacity: 0; }
}
`;
