// The DOM half of the recovered-copy flow (spec D4/D6, bridge/pending-save.ts).
// Rendered inside <DocxEditor> beside the Bridge. Owns:
//  • telling the host a refused copy exists from an EARLIER session (the 412 of
//    this session is reported by the save loop itself, through the same callback);
//  • Restore — the copy goes on screen first, then saves over the server's
//    version (the student chose it), then the copy is dropped;
//  • Discard;
//  • retrying a save the network refused, the moment the WebView is back online —
//    otherwise offline edits wait for the next keystroke to leave.

import { useEffect, useRef, type RefObject } from "react";
import type { DocxEditorRef } from "@docx-editor.dev/react";
import type { PendingSave, RecoveredRef } from "../bridge/pending-save";
import type { SaveLoop } from "../bridge/save-loop";

export type RecoveryAction = { key: string; action: "restore" | "discard"; nonce: number };

export function PendingRecovery(p: {
  editorRef: RefObject<DocxEditorRef | null>;
  saveLoop: SaveLoop;
  pending: PendingSave;
  action: RecoveryAction | null | undefined;
  onRecovered: (r: RecoveredRef | null) => void;
}) {
  const seen = useRef(p.action?.nonce ?? -1);

  useEffect(() => {
    let alive = true;
    void p.pending.latestRecovered().then((r) => { if (alive && r) p.onRecovered(r); }).catch(() => {});
    return () => { alive = false; };
  }, [p.pending]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const a = p.action;
    if (!a || a.nonce === seen.current) return;
    seen.current = a.nonce;
    void (async () => {
      try {
        if (a.action === "discard") { await p.pending.discard(a.key); return; }
        const bytes = await p.pending.readRecovered(a.key);
        if (!bytes) { p.onRecovered(null); return; }
        p.editorRef.current?.load(bytes);
        p.saveLoop.markDirty();
        // The save writes these bytes as the pending copy before its PUT, so the
        // recovered record is redundant from here whatever the PUT answers.
        await p.saveLoop.flush().catch(() => {});
        await p.pending.discard(a.key);
      } catch (e) {
        console.warn("[docx] recovery action failed", e);
      }
    })();
  }, [p.action?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const retry = () => { void p.saveLoop.flush().catch(() => {}); };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [p.saveLoop]);

  return null;
}
