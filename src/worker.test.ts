// Failure cases for the token table, written before the role was read:
//  1. A role that is not exactly "editor" or "viewer" is let in: null, a number, "Viewer", "owner", "".
//  2. A missing role becomes anything but editor.
//  3. A short token or a missing kind gets in with a role.
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
});
