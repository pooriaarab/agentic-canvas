#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { BRAND } from "./brand.js";
import { CanvasError } from "./core/board.js";
import { ActorConfigError, operatorActor } from "./actor.js";
import type { Principal } from "./core/principal.js";
import { runMcp } from "./mcp.js";
import { svgToPng } from "./png.js";
import { CanvasService, type BoardAccess } from "./service.js";
import { openLocalStore } from "./store-file.js";

class UsageError extends Error {}

const HELP = `${BRAND.command} ${BRAND.version}
${BRAND.description}

Usage: ${BRAND.command} [--dir <path>] <command> [flags]

Commands:
  new [--id <id>] [--title <t>]            Make a board.
  list                                     List the boards with their titles.
  read <board>                             Print the board as JSON.
  add <board> --type <t> --x <n> --y <n>   Add a shape. Also: --w --h --text --fill --stroke --src --id.
  connect <board> <from> <to> [--text <t>] Join two shapes with an arrow.
  update <board> <element> [--x --y --w --h --text --fill --stroke]  Change fields of an element. Resize with --w and --h.
  move <board> <element> --dx <n> --dy <n> Move an element or a group.
  delete <board>                           Delete a whole board for good.
  rm <board> <element>                     Delete an element.
  flow <board> --text <t> | --file <p>     Draw a flowchart from text ("A -> B: label"). Use --file - for stdin.
  export <board> [--format svg|png] [--out <path>]  Print SVG, or write PNG to --out.
  repair <board> [--drop <element>]...     Owner only: fix a broken or over-cap board. Needs CANVAS_ACTOR=human:<id>.
  mcp                                      Serve these as MCP tools on stdio. Needs CANVAS_ACTOR.

Live mode: set CANVAS_SERVER=<worker url> and CANVAS_TOKEN=<bearer token>. Every command then runs in the live room of
the board on that server, so a person and an agent can edit one board at once. The token sets the actor, the kind,
and the role, so CANVAS_ACTOR is not needed. If it is set, it must match the token. --dir, CANVAS_DIR, and repair are local only.

Write commands need an actor in CANVAS_ACTOR as <kind>:<id>, such as "agent:helper".
The operator sets it. A caller cannot pick its own kind: there is no --actor flag.
Kinds: human, agent_of_human, agent_of_agent, agent, user_token.
The store folder is --dir, or CANVAS_DIR, or ./.agentic-canvas.`;

const flags = {
  dir: { type: "string" }, id: { type: "string" }, title: { type: "string" },
  type: { type: "string" }, x: { type: "string" }, y: { type: "string" }, w: { type: "string" }, h: { type: "string" },
  text: { type: "string" }, fill: { type: "string" }, stroke: { type: "string" }, src: { type: "string" },
  dx: { type: "string" }, dy: { type: "string" }, file: { type: "string" }, prefix: { type: "string" },
  format: { type: "string" }, out: { type: "string" }, drop: { type: "string", multiple: true },
  help: { type: "boolean" }, version: { type: "boolean" },
} as const;

// A blank or non-numeric flag becomes NaN, so the model refuses it with a clear error.
const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : v.trim() === "" ? Number.NaN : Number(v));

// parseArgs refuses "--dx -5" as ambiguous. Join a negative number to its flag.
function joinNegatives(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1] ?? "";
    if (argv[i].startsWith("--") && !argv[i].includes("=") && /^-\d/.test(next)) out.push(`${argv[i]}=${argv[++i]}`);
    else out.push(argv[i]);
  }
  return out;
}

async function run(argv: string[]): Promise<void> {
  const { values: v, positionals } = parseArgs({ args: joinNegatives(argv), options: flags, allowPositionals: true });
  if (v.version) return void console.log(BRAND.version);
  const [command, board, ...rest] = positionals;
  if (v.help || command === undefined) return void console.log(HELP);
  const need = (count: number, shape: string): void => {
    if (positionals.length !== count + 1) throw new UsageError(`usage: ${BRAND.command} ${command} ${shape}`);
  };
  const server = process.env.CANVAS_SERVER;
  let live: Principal | undefined;
  let service: BoardAccess;
  if (server) {
    if (v.dir !== undefined || process.env.CANVAS_DIR) throw new UsageError("--dir and CANVAS_DIR are local only: CANVAS_SERVER is set, so the board lives on the server");
    const token = process.env.CANVAS_TOKEN;
    if (!token) throw new UsageError("CANVAS_SERVER needs CANVAS_TOKEN");
    if (command === "repair") throw new UsageError("repair runs on the local store only. Unset CANVAS_SERVER.");
    const { LiveService, whoAmI } = await import("./live.js");
    service = new LiveService({ server, token });
    const claimed = process.env.CANVAS_ACTOR;
    // A read needs no actor, but a CANVAS_ACTOR that is not the token's is still a mistake worth a stop.
    if (claimed || (command !== "read" && command !== "export")) live = (await whoAmI(server, token)).actor;
    if (live && claimed && claimed !== `${live.kind}:${live.id}`) throw new UsageError(`CANVAS_ACTOR "${claimed}" does not match the token (${live.kind}:${live.id}). Unset CANVAS_ACTOR.`);
  } else {
    service = new CanvasService(openLocalStore(v.dir ?? process.env.CANVAS_DIR ?? ".agentic-canvas"));
  }
  const actor = (): Principal => {
    if (live) return live;
    try {
      return operatorActor();
    } catch (error) {
      if (error instanceof ActorConfigError) throw new UsageError(`"${command}" needs an actor: ${error.message}`);
      throw error;
    }
  };
  const print = (value: unknown): void => console.log(JSON.stringify(value));
  switch (command) {
    case "new":
      need(0, "[--id <id>] [--title <t>]");
      return print(await service.create(actor(), { id: v.id, title: v.title }));
    case "list":
      need(0, "");
      return print({ boards: await service.list() });
    case "read":
      need(1, "<board>");
      return print(await service.read(board));
    case "add":
      need(1, "<board> --type <t> --x <n> --y <n>");
      return print(await service.add(board, { id: v.id, type: v.type, x: num(v.x), y: num(v.y), w: num(v.w), h: num(v.h), text: v.text, fill: v.fill, stroke: v.stroke, src: v.src }, actor()));
    case "connect":
      need(3, "<board> <from> <to> [--text <t>]");
      return print(await service.connect(board, { id: v.id, from: { id: rest[0] }, to: { id: rest[1] }, text: v.text }, actor()));
    case "update": {
      need(2, "<board> <element> [--x <n>] [--y <n>] [--w <n>] [--h <n>] [--text <t>] [--fill <c>] [--stroke <c>]");
      const patch = Object.fromEntries(Object.entries({ x: num(v.x), y: num(v.y), w: num(v.w), h: num(v.h), text: v.text, fill: v.fill, stroke: v.stroke }).filter(([, value]) => value !== undefined));
      return print(await service.update(board, rest[0], patch, actor()));
    }
    case "move":
      need(2, "<board> <element> --dx <n> --dy <n>");
      return print(await service.move(board, rest[0], num(v.dx) ?? Number.NaN, num(v.dy) ?? Number.NaN, actor()));
    case "delete":
      need(1, "<board>");
      return print(await service.delete(board));
    case "rm":
      need(2, "<board> <element>");
      return print(await service.remove(board, rest[0]));
    case "flow": {
      need(1, "<board> --text <t> | --file <path>");
      if ((v.text === undefined) === (v.file === undefined)) throw new UsageError("flow needs exactly one of --text and --file");
      const text = v.text ?? readFileSync(v.file === "-" ? 0 : v.file!, "utf8");
      return print(await service.flow(board, text, actor(), { idPrefix: v.prefix }));
    }
    case "export": {
      need(1, "<board> [--format svg|png] [--out <path>]");
      const format = v.format ?? "svg";
      if (format !== "svg" && format !== "png") throw new UsageError(`format must be svg or png, got "${format}"`);
      if (format === "png" && !v.out) throw new UsageError("png is binary: pass --out <path>");
      const data = format === "svg" ? await service.exportSvg(board) : await svgToPng(await service.exportSvg(board));
      if (!v.out) return void process.stdout.write(`${data}\n`);
      writeFileSync(v.out, data);
      return print({ out: v.out, format, bytes: data.length });
    }
    case "repair":
      need(1, "<board> [--drop <element>]...");
      return print(await (service as CanvasService).repair(board, actor(), v.drop ?? []));
    case "mcp":
      need(0, "");
      return runMcp(service, actor());
    default:
      throw new UsageError(`unknown command "${command}"`);
  }
}

run(process.argv.slice(2)).catch((error: unknown) => {
  const code = (error as { code?: string }).code ?? "";
  if (error instanceof UsageError || code.startsWith("ERR_PARSE_ARGS")) {
    console.error(`${(error as Error).message}\nRun "${BRAND.command} --help" for usage.`);
    process.exitCode = 2;
  } else if (error instanceof CanvasError) {
    console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
