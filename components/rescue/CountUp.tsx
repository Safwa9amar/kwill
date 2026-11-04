import React, { useEffect, useState } from "react";
import { Text, type StyleProp, type TextStyle } from "react-native";

interface Props {
  to: number;
  durationMs?: number;
  style?: StyleProp<TextStyle>;
}

/** A whole number that counts up to `to` on mount, and again whenever `to` changes. Cancelled on unmount. */
export function CountUp({ to, durationMs = 900, style }: Props) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const start = Date.now();
    let frame = 0;
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / durationMs);
      setValue(Math.round(to * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [to, durationMs]);
  return <Text style={style}>{value}</Text>;
}
