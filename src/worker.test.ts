// Failure cases for the token table, written before the role was read: a role that is not exactly "editor" or
// "viewer" gets in, a missing role is not editor, or a grant with no kind gets in.
import { describe, expect, test } from "vitest";
import { authenticate } from "./worker.js";

const TOKEN = "t".repeat(40);
const ask = (grant: unknown, token = TOKEN) =>
  authenticate(new Request("http://x/", { headers: { authorization: `Bearer ${token}` } }), { CANVAS_API_TOKENS: JSON.stringify({ [TOKEN]: grant }) } as never);

describe("token roles", () => {
  test("a missing role is editor, and viewer is kept", () => {
    expect(ask({ actor: "a", kind: "human" })).toEqual({ actor: { kind: "human", id: "a" }, role: "editor" });
    expect(ask({ actor: "a", kind: "agent", role: "viewer" })?.role).toBe("viewer");
  });

  test.each([null, 1, "Viewer", "owner", "", true, {}, ["viewer"]])("the role %j denies the token", (role) => {
    expect(ask({ actor: "a", kind: "human", role })).toBeNull();
  });

  test("a grant with no kind, or another token, gets nothing", () => {
    expect(ask({ actor: "a", role: "editor" })).toBeNull();
    expect(ask({ actor: "a", kind: "human" }, "u".repeat(40))).toBeNull();
  });

  test("the room's seeder name is no token's name", () => {
    expect(ask({ actor: "canvas-room", kind: "agent" })).toBeNull();
    expect(ask({ actor: "canvas-room", kind: "human" })?.actor.id).toBe("canvas-room");
  });
});

// The browser sends its token as a sub-protocol. Failure cases, written before the parser: a wrong name or a third
// protocol gets in, bad base64url or bytes that are not UTF-8 throw, an unknown token gets in, a viewer becomes an
// editor, the token works on a plain request, or a wrong Authorization header falls back to the sub-protocol.
describe("token as a WebSocket sub-protocol", () => {
  const env = { CANVAS_API_TOKENS: JSON.stringify({ [TOKEN]: { actor: "a", kind: "human" }, ["v".repeat(40)]: { actor: "v", kind: "human", role: "viewer" } }) } as never;
  const b64 = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const socket = (protocol: string | null, extra: Record<string, string> = {}, upgrade = "websocket") =>
    authenticate(new Request("http://x/", { headers: { ...(upgrade ? { upgrade } : {}), ...(protocol === null ? {} : { "sec-websocket-protocol": protocol }), ...extra } }), env);

  test("a good token works, and the viewer role is kept", () => {
    expect(socket(`agentic-canvas.bearer, ${b64(TOKEN)}`)).toEqual({ actor: { kind: "human", id: "a" }, role: "editor" });
    expect(socket(`agentic-canvas.bearer,${b64("v".repeat(40))}`)?.role).toBe("viewer");
  });

  test.each([
    ["a wrong protocol name", `other.bearer, ${b64(TOKEN)}`],
    ["a third protocol", `agentic-canvas.bearer, ${b64(TOKEN)}, extra`],
    ["no token part", "agentic-canvas.bearer"],
    ["characters outside base64url", "agentic-canvas.bearer, a+b/c="],
    ["bytes that are not UTF-8", "agentic-canvas.bearer, _w"],
    ["an unknown token", `agentic-canvas.bearer, ${b64("u".repeat(40))}`],
  ])("%s gets nothing", (_name, protocol) => {
    expect(socket(protocol)).toBeNull();
  });

  test("a plain request cannot use it, and a wrong Authorization header does not fall back to it", () => {
    expect(socket(`agentic-canvas.bearer, ${b64(TOKEN)}`, {}, "")).toBeNull();
    expect(socket(`agentic-canvas.bearer, ${b64(TOKEN)}`, { authorization: `Bearer ${"u".repeat(40)}` })).toBeNull();
  });
});
