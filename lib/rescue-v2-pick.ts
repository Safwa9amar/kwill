/**
 * The Start screen's pure rules: which picked files are Word files, and whether the picked parts pass the server's limits. Kept apart from
 * the screen so both can be tested without React Native.
 */

export interface PickedFile {
  uri: string;
  name: string;
  size: number;
}

const DOCX = /\.docx$/i;
const MB = 1024 * 1024;

/** The picker's filter is by MIME type, but a file can still carry a non-Word name: only `.docx` names go on. */
export function keepDocx<T extends { name: string }>(files: T[]): T[] {
  return files.filter((f) => DOCX.test(f.name));
}

/** `tooMany` is the count; `tooLarge` names the limit it passed, in MB, so the copy can say how big is allowed. */
export type PartsRefusal = { key: "tooMany" } | { key: "tooLarge"; mb: number };

/**
 * Checks the picked parts against the server's limits before any upload. The server checks again (its 413 and 400 answers reach the
 * error line), so this only spares the student a round trip. A size of 0 means the picker did not say, and counts as fitting.
 */
export function partsRefusal(
  files: PickedFile[],
  limits: { partMb: number; parts: number; totalMb: number },
): PartsRefusal | null {
  if (files.length > limits.parts) return { key: "tooMany" };
  if (files.some((f) => f.size > limits.partMb * MB)) return { key: "tooLarge", mb: limits.partMb };
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > limits.totalMb * MB) return { key: "tooLarge", mb: limits.totalMb };
  return null;
}
