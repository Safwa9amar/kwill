import { Redirect, useLocalSearchParams, type Href } from "expo-router";
import { LivingScreen } from "@/components/rescue/LivingScreen";
import { RESCUE_V2_ENABLED } from "@/lib/rescue-v2-enabled";
import { RESCUE_FIXTURES } from "@/lib/rescue-v2-fixtures";
import type { RescuePhase } from "@/types/rescue-v2";

/** Dev only (Step 11): `?fixture=<phase>` opens the living screen on a canned project. Never in a release build. */
function fixtureParam(v: string | undefined): RescuePhase | undefined {
  if (!__DEV__ || !v) return undefined;
  return (Object.keys(RESCUE_FIXTURES) as RescuePhase[]).find((k) => k === v);
}

export default function RescueIndex() {
  const params = useLocalSearchParams<{ projectId?: string; view?: string; share?: string; fixture?: string }>();
  if (!RESCUE_V2_ENABLED) return <Redirect href={"/(app)/chat" as Href} />;
  return (
    <LivingScreen
      projectId={params.projectId}
      view={params.view}
      share={params.share === "1" || params.share === "true"}
      fixture={fixtureParam(params.fixture)}
    />
  );
}
