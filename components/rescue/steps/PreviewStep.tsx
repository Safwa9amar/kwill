import type { RescueStep } from "./index";

// Stub for screen "preview" (Task A3). Rendering nothing; the Group A-B task that owns this step replaces it.
const Stage = () => null;
const Sheet = () => null;

export const PreviewStep: RescueStep = { Stage, Sheet };
