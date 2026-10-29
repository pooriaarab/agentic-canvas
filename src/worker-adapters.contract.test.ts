// The Worker runs on the D1 and R2 adapters of the shared ports, so they run the shared contract suites here too,
// against a real D1 database and a real R2 bucket served by miniflare.
import { runBlobsContract, runStoreContract } from "agentic-identity/testing";
import { D1_SCHEMA, createD1Store, createR2Blobs, type D1Like, type R2Like } from "agentic-identity/cloudflare";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll } from "vitest";

const SECRET = "0123456789abcdef0123456789abcdef-secret";
let mf: Miniflare;
let db: D1Like;
let bucket: R2Like;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "contract-db" },
    r2Buckets: { BUCKET: "contract-bucket" },
  });
  db = (await mf.getD1Database("DB")) as unknown as D1Like;
  bucket = (await mf.getR2Bucket("BUCKET")) as unknown as R2Like;
  await db.prepare(D1_SCHEMA).run();
});

afterAll(() => mf.dispose());

runStoreContract(async (options) => {
  await db.prepare("DELETE FROM store_docs").run();
  return createD1Store(db, { region: "unknown", ...options });
});

// `shared` names one set of keys: two Blobs with the same name see the same objects, as two Workers do.
runBlobsContract((options) => {
  const prefix = `${options.shared ?? crypto.randomUUID()}/`;
  const scoped: R2Like = {
    put: (key, value, opts) => bucket.put(prefix + key, value, opts),
    get: (key) => bucket.get(prefix + key),
    head: (key) => bucket.head(prefix + key),
    delete: (key) => bucket.delete(prefix + key),
  };
  return createR2Blobs(scoped, { region: "unknown", ...options, urlBase: "https://images.example.test/blob", urlSecret: SECRET });
});
