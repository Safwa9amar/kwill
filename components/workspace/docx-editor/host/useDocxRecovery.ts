// Native half of the recovered-copy flow (Task 28): the DOM reports a copy the
// server refused (a 412 this session, or one left by an earlier session); the
// student picks Restore or Discard; the choice goes back as a nonce'd prop. The
// banner hides on the tap itself — the DOM puts restored text on screen at once,
// so there is nothing to wait for.

import { useCallback, useRef, useState } from "react";
import type { RecoveredRef } from "../bridge/pending-save";
import type { RecoveryAction } from "../features/PendingRecovery";

export function useDocxRecovery() {
  const [offer, setOfferState] = useState<RecoveredRef | null>(null);
  const offerRef = useRef<RecoveredRef | null>(null);
  const [action, setAction] = useState<RecoveryAction | null>(null);
  const nonce = useRef(0);
  const setOffer = (r: RecoveredRef | null) => { offerRef.current = r; setOfferState(r); };
  const onRecovered = useCallback(async (r: RecoveredRef | null) => { setOffer(r); }, []);
  const decide = useCallback((kind: RecoveryAction["action"]) => {
    const cur = offerRef.current;
    if (!cur) return;
    setOffer(null);
    setAction({ key: cur.key, action: kind, nonce: ++nonce.current });
  }, []);
  const restore = useCallback(() => decide("restore"), [decide]);
  const discard = useCallback(() => decide("discard"), [decide]);
  return { offer, action, onRecovered, restore, discard };
}
