// Plain words for a failed call. This file holds no import of the client, so the embed shares no code with it:
// an error thrown by the host's own client (any copy of the class) is read by its name and code.
export interface ApiFailure { name: "CanvasApiError"; code: string; status: number; message: string }

export const isApiError = (error: unknown): error is ApiFailure =>
  typeof error === "object" && error !== null && (error as { name?: unknown }).name === "CanvasApiError" && typeof (error as { code?: unknown }).code === "string" && typeof (error as { status?: unknown }).status === "number";

export function describe(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "UNAUTHORIZED") return "The server did not accept this token.";
    if (error.code === "NETWORK") return "The server cannot be reached. Check the connection and try again.";
    if (error.code === "FORBIDDEN") return "This token can read the board but not change it.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
