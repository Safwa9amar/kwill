import type { RescueNoteChipDTO } from "@/types/rescue-v2";

interface NoteChipsProps {
  chips: RescueNoteChipDTO[];
  onRemove?: (chipId: string) => void;
}

// Stub (Task A3). The note step's chips are built in a later task; this renders nothing.
export function NoteChips(_props: NoteChipsProps) {
  return null;
}
