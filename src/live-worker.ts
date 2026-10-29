import { parseRegion } from "agentic-identity";
import { createDurableObjectRealtime } from "agentic-realtime/worker";
import { CanvasError } from "./core/board.js";
import { createApp, type WorkerEnv } from "./worker.js";

export { SyncRoom } from "agentic-realtime/worker";

type Namespace = Parameters<typeof createDurableObjectRealtime>[0];

export interface LiveEnv extends WorkerEnv {
  /** Durable Object namespace of the live rooms. Bind `SyncRoom` to it. */
  SYNC_ROOM?: Namespace;
}

/** The Worker with live rooms: one Durable Object per board, in the EU jurisdiction when the region is "eu" (there is no US one). */
const app = createApp({
  live: (env) => {
    const rooms = (env as LiveEnv).SYNC_ROOM;
    if (!rooms) throw new CanvasError("UNAVAILABLE", "bind a Durable Object namespace as SYNC_ROOM");
    return createDurableObjectRealtime(rooms, parseRegion(env.CANVAS_REGION ?? "") === "eu" ? "eu" : undefined);
  },
});

export default { fetch: (request: Request, env: LiveEnv, ctx: unknown) => app.fetch(request, env, ctx as never) };
