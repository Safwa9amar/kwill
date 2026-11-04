// What "Choose the file again" deletes when the cold start lost an upload. Pure, so the choice is tested under node.

export type LostUploadTarget =
  | { kind: "project"; projectId: string }
  | { kind: "version"; versionId: string }
  | { kind: "none" };

/**
 * A first upload (v0) is the only version the project has, so it deletes the project. A re-run's upload deletes that re-run's version alone:
 * the project keeps every finished version and its deposit pack. When a finished version beside v0 exists but no version is active, nothing is
 * deleted: the choice is refused rather than guessed.
 */
export function lostUploadTarget(p: {
  id: string;
  originalVersionId: string;
  activeVersionId: string | null;
  currentVersion: { id: string } | null;
}): LostUploadTarget {
  const isRerun = (versionId: string | null) => versionId !== null && versionId !== p.originalVersionId;
  if (isRerun(p.activeVersionId)) return { kind: "version", versionId: p.activeVersionId as string };
  if (isRerun(p.currentVersion?.id ?? null)) return { kind: "none" };
  return { kind: "project", projectId: p.id };
}
