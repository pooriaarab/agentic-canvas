// Start the real Worker under `wrangler dev` for the end-to-end tests. Each Worker takes its own port.
// Workers given the same `persistTo` folder share one local D1 database, as two instances share one D1.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const WRANGLER = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

export interface RunningWorker {
  url: string;
  /** The last output of the Worker. */
  log(): string;
  stop(): Promise<void>;
}

export async function startWorker(options: { port: number; persistTo: string; vars?: string[] }): Promise<RunningWorker> {
  const { port, persistTo, vars = [] } = options;
  const args = ["dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(port + 100), "--persist-to", persistTo, ...vars.flatMap((v) => ["--var", v])];
  const busy = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }).then(() => true, (error: Error) => error.name === "TimeoutError");
  if (busy) throw new Error(`port ${port} is already served`);
  const server: ChildProcess = spawn(process.execPath, [WRANGLER, ...args], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  for (const stream of [server.stdout, server.stderr]) stream?.on("data", (chunk: Buffer) => (log = (log + chunk.toString()).slice(-2000)));
  const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
  // A Worker that is still running holds its port, and the next one would answer from the old process.
  const stop = async () => {
    const gone = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
    // Wrangler starts workerd and esbuild. A signal to the whole group stops them too.
    const signal = (name: NodeJS.Signals) => (server.pid === undefined ? server.kill(name) : process.kill(-server.pid, name));
    signal("SIGTERM");
    if (await gone(10_000)) return;
    signal("SIGKILL");
    if (!(await gone(5_000))) throw new Error(`wrangler dev on port ${port} did not stop`);
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
      return { log: () => log, url: `http://127.0.0.1:${port}/api/v1/canvas`, stop };
    } catch {
      if (Date.now() > deadline) {
        await stop();
        throw new Error(`wrangler dev did not start in time. Last output: ${log}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
