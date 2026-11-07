import { Redirect, useLocalSearchParams, type Href } from "expo-router";
import { LivingScreen } from "@/components/rescue/LivingScreen";
import { RESCUE_V2_ENABLED } from "@/lib/rescue-v2-enabled";

export default function RescueIndex() {
  const params = useLocalSearchParams<{ projectId?: string; view?: string; share?: string }>();
  if (!RESCUE_V2_ENABLED) return <Redirect href={"/(app)/chat" as Href} />;
  return (
    <LivingScreen
      projectId={params.projectId}
      view={params.view}
      share={params.share === "1" || params.share === "true"}
    />
  );
}
