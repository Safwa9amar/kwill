import type { RescueStep } from "./index";

// Stub for screen "parts" (Task A3). Rendering nothing; the Group A-B task that owns this step replaces it.
const Stage = () => null;
const Sheet = () => null;

export const PartsStep: RescueStep = { Stage, Sheet };
