// A typed client for the Worker HTTP API. It uses only `fetch`, so it runs in browsers, Workers, and Node 22.
// It never retries: a 503 says "try again", and the caller decides, because a repeated write can change a board twice.
import type { BoardData } from "./core/read.js";
import type { Connector, Endpoint, ErrorCode, Shape, ShapeType } from "./core/board.js";
import type { PrincipalKind } from "./core/principal.js";

export interface ClientOptions {
  /** The API root, for example `https://canvas.example.com/api/v1/canvas`. */
  baseUrl: string;
  /** A bearer token. The token sets the actor, the kind, and the role. */
  token: string;
  /** A custom `fetch`. Defaults to the global one. */
  fetch?: typeof fetch;
}

/** Options for every call. */
export interface CallOptions {
  signal?: AbortSignal;
}

export interface ShapeInput {
  id?: string;
  type: ShapeType;
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  fill?: string;
  stroke?: string;
  /** A `data:` URL or a `blob:` ref, for an image. */
  src?: string;
}

export interface ConnectorInput {
  id?: string;
  from: Endpoint;
  to: Endpoint;
  text?: string;
  startArrow?: boolean;
  endArrow?: boolean;
  stroke?: string;
}

export type ShapePatch = Partial<Pick<ShapeInput, "x" | "y" | "w" | "h" | "text" | "fill" | "stroke" | "src">>;
export type ConnectorPatch = Partial<Pick<ConnectorInput, "from" | "to" | "text" | "startArrow" | "endArrow" | "stroke">>;

export interface ImageInfo {
  id: string;
  ref: string;
  type: string;
  size: number;
  /** False when the same bytes were stored before. */
  created: boolean;
}

/**
 * A failed call. `code` is the API error code, such as `NOT_FOUND`, `UNAUTHORIZED`, or `INVALID`. `status` is the HTTP status.
 * A reply that is not the API's error shape has code `HTTP_ERROR`. A call that never got a reply has code `NETWORK` and status 0.
 */
export type ApiErrorCode = ErrorCode | "UNAUTHORIZED" | "NOT_CONFIGURED" | "TOO_LARGE" | "UNSUPPORTED_TYPE" | "UPGRADE_REQUIRED" | "INTERNAL" | "NETWORK" | "HTTP_ERROR" | (string & {});

export class CanvasApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CanvasApiError";
  }
}

export interface CanvasClient {
  /** Who the token stands for. */
  me(options?: CallOptions): Promise<{ actor: string; kind: PrincipalKind; role: "editor" | "viewer" }>;
  /** The first 100 boards, with titles. */
  listBoards(options?: CallOptions): Promise<{ boards: { id: string; title: string }[] }>;
  createBoard(input?: { id?: string; title?: string }, options?: CallOptions): Promise<{ id: string; title: string }>;
  readBoard(id: string, options?: CallOptions): Promise<BoardData & { id: string }>;
  /** The board as an SVG document. */
  exportSvg(id: string, options?: CallOptions): Promise<string>;
  addShape(id: string, shape: ShapeInput, options?: CallOptions): Promise<Shape>;
  addConnector(id: string, connector: ConnectorInput, options?: CallOptions): Promise<Connector>;
  /** Draw a flowchart from text such as `A -> B: label`. Returns the new ids. */
  drawFlow(id: string, text: string, options?: CallOptions): Promise<{ nodes: string[]; edges: string[] }>;
  /** Change fields of one shape or connector, such as its size or text. The patch holds at least one field. */
  update(id: string, element: string, patch: ShapePatch | ConnectorPatch, options?: CallOptions): Promise<Shape | Connector>;
  /** Move an element. Returns the ids that moved: a shape takes its connectors with it. */
  move(id: string, element: string, dx: number, dy: number, options?: CallOptions): Promise<{ moved: string[] }>;
  /** Remove an element. Returns the ids removed. */
  remove(id: string, element: string, options?: CallOptions): Promise<{ removed: string[] }>;
  uploadImage(bytes: Uint8Array | ArrayBuffer | Blob, options?: CallOptions): Promise<ImageInfo>;
  /** The bytes of a stored image, and its content type. */
  getImage(id: string, options?: CallOptions): Promise<{ bytes: Uint8Array; type: string }>;
  /** The stored board as a Yjs update. Only a server with live rooms serves it. */
  state(id: string, options?: CallOptions): Promise<Uint8Array>;
  /** Merge a live room's Yjs update into the stored board. Only a server with live rooms serves it. */
  checkpoint(id: string, update: Uint8Array, options?: CallOptions): Promise<{ elements: number; fixed: string[] }>;
}

export function createClient(options: ClientOptions): CanvasClient {
  const { token } = options;
  const base = options.baseUrl.replace(/\/+$/, "");
  if (!token) throw new TypeError("token is required");
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const seg = encodeURIComponent;

  async function send(method: string, path: string, init: { json?: unknown; body?: BodyInit; contentType?: string }, call?: CallOptions): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    if (init.contentType) headers["content-type"] = init.contentType;
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: init.json === undefined ? init.body : JSON.stringify(init.json),
        signal: call?.signal,
      });
    } catch (error) {
      // An abort is the caller's own act: pass it through unchanged.
      if (call?.signal?.aborted) throw error;
      throw new CanvasApiError("NETWORK", error instanceof Error ? error.message : "the request failed", 0);
    }
    if (response.ok) return response;
    let code = "HTTP_ERROR";
    let message = `the server answered ${response.status}`;
    try {
      const { error } = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
      if (typeof error?.code === "string") code = error.code;
      if (typeof error?.message === "string") message = error.message;
    } catch {
      // An abort while the body is read is still the caller's own act.
      if (call?.signal?.aborted) throw call.signal.reason;
      // Not the API's error shape: keep the HTTP defaults.
    }
    throw new CanvasApiError(code, message, response.status);
  }

  // A reply that is not JSON, such as a proxy page with status 200, is an API error too.
  const parse = async <T>(response: Response, call?: CallOptions): Promise<T> => {
    try {
      return (await response.json()) as T;
    } catch (error) {
      if (call?.signal?.aborted) throw error;
      throw new CanvasApiError("HTTP_ERROR", "the server did not answer with JSON", response.status);
    }
  };
  const json = async <T>(method: string, path: string, body?: unknown, call?: CallOptions): Promise<T> =>
    parse<T>(await send(method, path, { json: body }, call), call);
  const bytes = async (response: Response) => new Uint8Array(await response.arrayBuffer());

  return {
    me: (o) => json("GET", "/me", undefined, o),
    listBoards: (o) => json("GET", "/boards", undefined, o),
    createBoard: (input = {}, o) => json("POST", "/boards", input, o),
    readBoard: (id, o) => json("GET", `/boards/${seg(id)}`, undefined, o),
    exportSvg: async (id, o) => (await send("GET", `/boards/${seg(id)}/svg`, {}, o)).text(),
    addShape: (id, shape, o) => json("POST", `/boards/${seg(id)}/shapes`, shape, o),
    addConnector: (id, connector, o) => json("POST", `/boards/${seg(id)}/connectors`, connector, o),
    drawFlow: (id, text, o) => json("POST", `/boards/${seg(id)}/flow`, { text }, o),
    update: (id, element, patch, o) => json("PATCH", `/boards/${seg(id)}/elements/${seg(element)}`, patch, o),
    move: (id, element, dx, dy, o) => json("POST", `/boards/${seg(id)}/move`, { element, dx, dy }, o),
    remove: (id, element, o) => json("DELETE", `/boards/${seg(id)}/elements/${seg(element)}`, undefined, o),
    uploadImage: async (data, o) => parse<ImageInfo>(await send("POST", "/images", { body: data as BodyInit, contentType: "application/octet-stream" }, o), o),
    getImage: async (id, o) => {
      const response = await send("GET", `/images/${seg(id)}`, {}, o);
      return { bytes: await bytes(response), type: response.headers.get("content-type") ?? "application/octet-stream" };
    },
    state: async (id, o) => bytes(await send("GET", `/boards/${seg(id)}/state`, {}, o)),
    checkpoint: async (id, update, o) =>
      parse(await send("POST", `/boards/${seg(id)}/checkpoint`, { body: update as BodyInit, contentType: "application/octet-stream" }, o), o),
  };
}
