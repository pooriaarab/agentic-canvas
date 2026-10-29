// Service-level tests. They run the real service over the real file store, with no mock.
//
// Failure-mode list. These were written before the owner repair check on the actor.
//  1. A human actor with no id, an empty id, or an extra field is refused as INVALID.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { Principal } from "./core/principal.js";
import { CanvasService } from "./service.js";
import { fileStore } from "./store.js";

const root = mkdtempSync(join(tmpdir(), "canvas-service-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const human: Principal = { kind: "human", id: "ada" };

describe("owner repair actor", () => {
  test.each([
    ["a missing id", { kind: "human" }],
    ["an empty id", { kind: "human", id: "" }],
    ["an extra field", { kind: "human", id: "ada", role: "owner" }],
  ])("%s is refused as INVALID", async (_name, actor) => {
    const service = new CanvasService(fileStore(join(root, `s${n++}`)));
    await service.create(human, { id: "b" });
    await expect(service.repair("b", actor as Principal)).rejects.toMatchObject({ code: "INVALID" });
  });
});
