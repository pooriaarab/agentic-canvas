// Dev smoke: start `wrangler dev`, wait for the health route to answer 200, then stop it.
// Usage: node scripts/dev-smoke.mjs <port> <health-path> [extra wrangler dev args]
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const port = Number(process.argv[2]);
const path = process.argv[3] ?? "/health";
const extra = process.argv.slice(4);
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: node scripts/dev-smoke.mjs <port> <health-path> [wrangler args]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A server that already holds the port would answer 200 and give a false pass.
const busy = await new Promise((resolve) => {
  const probe = createServer();
  probe.once("error", () => resolve(true));
  probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(false)));
});
if (busy) {
  console.error(`dev smoke failed: port ${port} is already in use`);
  process.exit(1);
}

const child = spawn("npx", ["wrangler", "dev", "--port", String(port), ...extra], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
let exited = false;
child.on("exit", () => {
  exited = true;
});

// Signal the whole process group (npx, wrangler, workerd). Escalate to SIGKILL after 5 seconds.
const signalGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return false;
  }
};
const stop = async () => {
  if (!signalGroup("SIGTERM")) return;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && signalGroup(0)) await sleep(100);
  if (signalGroup(0)) signalGroup("SIGKILL");
};
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, async () => {
    await stop();
    process.exit(130);
  });
}

const url = `http://127.0.0.1:${port}${path}`;
let status = 0;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && !exited) {
  try {
    status = (await fetch(url, { signal: AbortSignal.timeout(5000) })).status;
    if (status === 200) break;
  } catch {
    // The server is not up yet.
  }
  await sleep(1000);
}
const ok = status === 200 && !exited;
await stop();
if (ok) {
  console.log(`dev smoke ok: GET ${url} answered 200`);
  process.exit(0);
}
console.error(`dev smoke failed: GET ${url} did not answer 200 (last status ${status})`);
process.exit(1);
