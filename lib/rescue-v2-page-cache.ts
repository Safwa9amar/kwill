const inflight = new Map<string, Promise<string>>();
/** One download per page, ever: the hash names the bytes, and a signed URL changes at every signing (P-12). */
export function localPageUri(hash: string, url: string): Promise<string> {
  const held = inflight.get(hash);
  if (held) return held;
  const p = (async () => {
    const { Directory, File, Paths } = await import("expo-file-system");
    const dir = new Directory(Paths.cache, "rescue-pages");
    if (!dir.exists) dir.create({ intermediates: true });
    const file = new File(dir, `${hash}.jpg`);
    if (file.exists) return file.uri;
    return (await File.downloadFileAsync(url, file)).uri;
  })().finally(() => inflight.delete(hash));
  inflight.set(hash, p);
  return p;
}
