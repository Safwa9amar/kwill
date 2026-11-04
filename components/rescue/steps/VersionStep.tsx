import type { RescueStep } from "./index";

// Stub for screen "version" (Task A3). Rendering nothing; the Group A-B task that owns this step replaces it.
const Stage = () => null;
const Sheet = () => null;

export const VersionStep: RescueStep = { Stage, Sheet };
