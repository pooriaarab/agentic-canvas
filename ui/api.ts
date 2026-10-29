// The token lives in this tab only. The Worker maps it to the actor, the kind, and the role.
import { CanvasApiError, createClient, type CanvasClient } from "../src/client";
import { describe } from "./errors";

const KEY = "agentic-canvas.token";
export const API = "/api/v1/canvas";

export const getToken = (): string | null => sessionStorage.getItem(KEY);
export const setToken = (token: string | null): void => (token ? sessionStorage.setItem(KEY, token) : sessionStorage.removeItem(KEY));
export const clientFor = (token: string): CanvasClient => createClient({ baseUrl: `${window.location.origin}${API}`, token });

export { CanvasApiError, describe };
