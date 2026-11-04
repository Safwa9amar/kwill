/**
 * Every way into Rescue v2 goes through this one constant (D-19: one release).
 * `: boolean`, not the inferred literal: typed wide, both states are checked by tsc,
 * the same reasoning as lib/tasks-enabled.ts. The release commit sets this to `true`.
 */
export const RESCUE_V2_ENABLED: boolean = __DEV__;
