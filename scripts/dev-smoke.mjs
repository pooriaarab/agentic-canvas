// Dev smoke: start `wrangler dev`, wait for the health route to answer 200, then stop it.
// Usage: node scripts/dev-smoke.mjs <port> <health-path>
import { spawn } from "node:child_process";

const port = Number(process.argv[2]);
const path = process.argv[3] ?? "/health";
if (!Number.isInteger(port) || port <= 0) {
  console.error("usage: node scripts/dev-smoke.mjs <port> <health-path>");
  process.exit(2);
}

const child = spawn("npx", ["wrangler", "dev", "--port", String(port)], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
let exited = false;
child.on("exit", () => {
  exited = true;
});

const stop = () => {
  if (exited) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The process group is already gone.
  }
};
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

const url = `http://127.0.0.1:${port}${path}`;
let status = 0;
const deadline = Date.now() + 90_000;
while (Date.now() < deadline && !exited) {
  try {
    status = (await fetch(url)).status;
    if (status === 200) break;
  } catch {
    // The server is not up yet.
  }
  await new Promise((r) => setTimeout(r, 1000));
}
stop();
if (status === 200) {
  console.log(`dev smoke ok: GET ${url} answered 200`);
  process.exit(0);
}
console.error(`dev smoke failed: GET ${url} did not answer 200 (last status ${status})`);
process.exit(1);
