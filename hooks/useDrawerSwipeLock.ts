import { useCallback } from "react";
import { useFocusEffect, useNavigation } from "expo-router";

// P-36. The drawer reads swipeEnabled from its focused screen, (app).
export function useDrawerSwipeLock() {
  const navigation = useNavigation();
  useFocusEffect(useCallback(() => {
    // The navigation object whose state is the drawer's is the (app) screen's: its options are the ones the drawer reads.
    let holder = navigation.getParent();
    while (holder && holder.getState()?.type !== "drawer") holder = holder.getParent();
    holder?.setOptions({ swipeEnabled: false });
    return () => holder?.setOptions({ swipeEnabled: true });
  }, [navigation]));
}
