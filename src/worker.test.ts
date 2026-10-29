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
});
