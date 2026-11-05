import { useEffect } from "react";
import { File } from "expo-file-system";
import { useIncomingShare } from "expo-sharing";
import { useRescueV2Store } from "@/stores/rescue-v2-store";

// Mounted by LivingScreen when the route carries share=1 (Task A10). It renders nothing: it takes the Word files a share brought, starts a
// project with them, and removes the shared copies once the server has every part. A thesis must not stay in the app group.
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function ShareInbox() {
  const { resolvedSharedPayloads, isResolving, clearSharedPayloads } = useIncomingShare();
  const begin = useRescueV2Store((s) => s.begin);

  useEffect(() => {
    if (isResolving || resolvedSharedPayloads.length === 0) return;
    const shared = resolvedSharedPayloads.filter((p) => p.contentType === "file" && p.contentUri);
    // A Word file by its name or, when the sender gave no usable name, by its type.
    const isDocx = (p: (typeof shared)[number]) => /\.docx$/i.test(p.originalName ?? "") || p.contentMimeType === DOCX_MIME;
    const files = shared.filter(isDocx).map((p) => ({
      uri: p.contentUri!,
      name: /\.docx$/i.test(p.originalName ?? "") ? p.originalName! : `${p.originalName || "thesis"}.docx`,
      size: p.contentSize ?? 0,
    }));
    clearSharedPayloads();
    // Anything else that came with the share is never used: it goes now.
    removeCopies(shared.filter((p) => !isDocx(p)).map((p) => p.contentUri!));
    if (!files.length) {
      // The shell's error line words this as start.notDocx (A3).
      useRescueV2Store.setState({ errorCode: "not_docx" });
      return;
    }
    // A failed begin keeps the copies: the student's retry needs them.
    begin(files, "share")
      .then((ok) => {
        if (ok) removeCopies(files.map((f) => f.uri));
      })
      .catch((e) => console.warn("[rescue] share begin failed", e));
  }, [isResolving, resolvedSharedPayloads]);

  return null;
}

function removeCopies(uris: string[]) {
  for (const uri of uris) {
    try {
      new File(uri).delete();
    } catch {
      // Already gone: nothing left to remove.
    }
  }
}
