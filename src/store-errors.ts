/** A file store failure the caller can act on. `code` says why: LOCKED or DAMAGED. */
export class FileStoreError extends Error {
  constructor(
    readonly code: "LOCKED" | "DAMAGED",
    message: string,
  ) {
    super(message);
    this.name = "FileStoreError";
  }
}
