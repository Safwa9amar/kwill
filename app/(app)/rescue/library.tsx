import { Redirect, type Href } from "expo-router";
import { RESCUE_V2_ENABLED } from "@/lib/rescue-v2-enabled";

// H1, the library. A stub until Task A8.
export default function RescueLibrary() {
  if (!RESCUE_V2_ENABLED) return <Redirect href={"/(app)/chat" as Href} />;
  return null;
}
