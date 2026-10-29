// The token lives in this tab only. The Worker maps it to the actor, the kind, and the role.
import { CanvasApiError, createClient, type CanvasClient } from "../src/client";

const KEY = "agentic-canvas.token";
export const API = "/api/v1/canvas";

export const getToken = (): string | null => sessionStorage.getItem(KEY);
export const setToken = (token: string | null): void => (token ? sessionStorage.setItem(KEY, token) : sessionStorage.removeItem(KEY));
export const clientFor = (token: string): CanvasClient => createClient({ baseUrl: `${window.location.origin}${API}`, token });

/** Plain words for a failed call. */
export function describe(error: unknown): string {
  if (error instanceof CanvasApiError) {
    if (error.code === "UNAUTHORIZED") return "The server did not accept this token.";
    if (error.code === "NETWORK") return "The server cannot be reached. Check the connection and try again.";
    if (error.code === "FORBIDDEN") return "This token can read the board but not change it.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}
export { CanvasApiError };
