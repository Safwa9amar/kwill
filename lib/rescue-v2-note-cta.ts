// The notes CTA as a sequence, pure so it runs under node. The screen supplies the store reads and the calls; this decides the order.

/** How often the note is re-read while it is being read, and how many re-reads before the CTA gives up waiting (about 90 s). */
export const NOTE_POLL_MS = 1500;
export const NOTE_POLLS = 60;

/**
 * `settled`: the note is read and no conflict is open, so the diagnosis may start. `conflict`: the note is read and a choice is owed.
 * `moved`: the student is on another project. `timeout`: the note still reads after the poll limit.
 */
export type NoteWait = "settled" | "conflict" | "moved" | "timeout";

export interface NoteReading { parsing: boolean; conflict: boolean; live: boolean }

/**
 * Re-reads the note through `read` and `refresh` until it is settled. A note still being read is polled every `ms`, at most `polls` times.
 * Never more than one start: the caller starts the diagnosis only on `settled`.
 */
export async function waitForNote(
  deps: { read(): NoteReading; refresh(): Promise<unknown>; sleep(ms: number): Promise<unknown> },
  polls = NOTE_POLLS,
  ms = NOTE_POLL_MS,
): Promise<NoteWait> {
  for (let i = 0; ; i++) {
    const r = deps.read();
    if (!r.live) return "moved";
    if (!r.parsing) return r.conflict ? "conflict" : "settled";
    if (i >= polls) return "timeout";
    await deps.sleep(ms);
    await deps.refresh();
  }
}

export interface NoteCtaRun {
  /** Sends the changed note. False when the send failed (the shell's line has the reason). */
  send(): Promise<boolean>;
  /** Waits for the note to settle (see `waitForNote`). */
  wait(): Promise<NoteWait>;
  /** Starts the diagnosis. Called at most once per tap. */
  start(): Promise<boolean>;
}

/**
 * The CTA: send a changed note, wait until it is settled, then start the diagnosis. A failed send, a conflict, a move of project or a
 * timeout stops before the start, so the server never refuses it with `note_parsing` or `note_conflict`.
 */
export async function runNoteCta(changed: boolean, run: NoteCtaRun): Promise<"started" | "stopped"> {
  if (changed && !(await run.send())) return "stopped";
  if ((await run.wait()) !== "settled") return "stopped";
  await run.start();
  return "started";
}
