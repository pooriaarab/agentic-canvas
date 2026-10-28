import type { Board, Connector, Shape } from "./board.js";
import { isMachineMade } from "./principal.js";

interface Labels {
  /** The author is an agent or acts for one. */
  machineMade: boolean;
  /** The last edit came from an agent or one acting for one. */
  lastEditMachineMade: boolean;
}
export type NodeData = Shape & Labels;
export type EdgeData = Connector & Labels;

export interface BoardData {
  title: string;
  nodes: NodeData[];
  edges: EdgeData[];
  groups: { id: string; members: string[] }[];
  /** Every non-empty text, back to front. */
  texts: string[];
}

/** The board as plain data for an agent. Reads only. Embedded image bytes are left out. */
export function readBoard(board: Board): BoardData {
  const data: BoardData = { title: board.title, nodes: [], edges: [], groups: [], texts: [] };
  const all = board.list();
  for (const el of all) {
    if (el.type === "group") {
      data.groups.push({ id: el.id, members: all.filter((m) => m.groupId === el.id).map((m) => m.id) });
      continue;
    }
    const labels = { machineMade: isMachineMade(el.author.kind), lastEditMachineMade: isMachineMade(el.editedBy.kind) };
    if (el.text !== "") data.texts.push(el.text);
    if (el.type === "connector") data.edges.push({ ...el, ...labels });
    else {
      const src = el.src?.startsWith("data:") ? `${el.src.slice(0, el.src.indexOf(","))},(${el.src.length} characters left out)` : el.src;
      data.nodes.push({ ...el, ...(src === undefined ? {} : { src }), ...labels });
    }
  }
  return data;
}
