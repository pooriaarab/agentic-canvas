// Presence from the live room. Edits go over the HTTP API. The room carries who is here, and a change counter:
// after each save a client raises `rev` in its presence, and every other client then reads the board again.
import { SyncClient, type Peer } from "agentic-realtime/client";
import type { PresenceEntry } from "agentic-design/react";
import { API } from "./api";

const WS_PROTOCOL = "agentic-canvas.bearer";
const b64url = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A browser cannot set a header on a WebSocket, so the token travels as a sub-protocol. */
class BearerSocket extends WebSocket {
  static token = "";
  constructor(url: string) {
    super(url, [WS_PROTOCOL, b64url(BearerSocket.token)]);
  }
}

export interface Room {
  setRev(rev: number): void;
  leave(): void;
}

/** A peer's state is data from another client. Only a finite counter passes. */
const revOf = (peer: Peer): number | null => {
  const rev = (peer.cursor as { rev?: unknown } | null)?.rev;
  return typeof rev === "number" && Number.isFinite(rev) ? rev : null;
};

export function toEntry(peer: Peer): PresenceEntry {
  return { id: String(peer.clientId), name: peer.name, kind: peer.machine ? "agent" : "person" };
}

export function joinRoom(options: { board: string; token: string; name: string; onPeers: (peers: PresenceEntry[]) => void; onChange: () => void; onStatus: (connected: boolean) => void }): Room {
  const url = new URL(`${API}/boards/${encodeURIComponent(options.board)}/ws`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  BearerSocket.token = options.token;
  const seen = new Map<number, number>();
  const client = SyncClient.open({
    url: url.toString(),
    WebSocket: BearerSocket as never,
    presence: { name: options.name, cursor: { rev: 0 } },
    reconnect: { initialMs: 1000, maxMs: 15_000 },
    onStatus: (status) => options.onStatus(status === "connected"),
  });
  const off = client.onPeers((peers) => {
    options.onPeers(peers.map(toEntry));
    let changed = false;
    for (const peer of peers) {
      const rev = revOf(peer);
      if (rev !== null && seen.has(peer.clientId) && seen.get(peer.clientId) !== rev) changed = true;
      if (rev !== null) seen.set(peer.clientId, rev);
    }
    if (changed) options.onChange();
  });
  return {
    setRev: (rev) => client.setPresence({ cursor: { rev } }),
    leave: () => {
      off();
      void client.disconnect();
    },
  };
}
