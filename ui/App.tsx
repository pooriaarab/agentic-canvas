import { AppShell, Button, Dialog, DialogClose, EmptyState, Input, Select, SidebarNav, useTheme, useToast } from "agentic-design/react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { CanvasClient } from "../src/client";
import { clientFor, describe, getToken, setToken } from "./api";
import { BoardView } from "./BoardView";
import { Failure } from "./Failure";

type Me = { actor: string; kind: string; role: "editor" | "viewer" };
type Boards = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; boards: { id: string; title: string }[] };

/** The board id from the address, or null for the list. */
const boardFromHash = (): string | null => {
  const m = /^#\/b\/([^/]+)$/.exec(window.location.hash);
  try {
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
};

function SignIn({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [token, setValue] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await clientFor(token.trim()).me();
      setToken(token.trim());
      onSignedIn(token.trim());
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="signin">
      <h1>Canvas</h1>
      <form onSubmit={submit}>
        <Input label="Access token" type="password" autoComplete="off" value={token} onChange={(e) => setValue(e.target.value)} hint="The token names you to the server. It stays in this tab." error={error} required />
        <Button type="submit" loading={busy}>Sign in</Button>
      </form>
    </main>
  );
}

function Workspace({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const client: CanvasClient = clientFor(token);
  const toast = useToast();
  const { preference, setPreference } = useTheme();
  const [me, setMe] = useState<Me>();
  const [list, setList] = useState<Boards>({ state: "loading" });
  const [board, setBoard] = useState<string | null>(boardFromHash());
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");

  const load = useCallback(async () => {
    setList({ state: "loading" });
    try {
      const [who, boards] = await Promise.all([clientFor(token).me(), clientFor(token).listBoards()]);
      setMe(who);
      setList({ state: "ready", boards: boards.boards });
    } catch (e) {
      setList({ state: "error", message: describe(e) });
    }
  }, [token]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    const onHash = () => setBoard(boardFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      const made = await client.createBoard(title.trim() ? { title: title.trim() } : {});
      setCreating(false);
      setTitle("");
      await load();
      window.location.hash = `#/b/${encodeURIComponent(made.id)}`;
    } catch (e) {
      toast({ title: "Could not create the board", description: describe(e), tone: "danger" });
    }
  }

  const boards = list.state === "ready" ? list.boards : [];
  const canWrite = me?.role === "editor";
  const newBoard = (
    <Dialog
      open={creating}
      onOpenChange={setCreating}
      title="New board"
      trigger={<Button disabled={!canWrite}>New board</Button>}
      footer={
        <>
          <DialogClose asChild><Button variant="secondary">Cancel</Button></DialogClose>
          <Button type="submit" form="new-board">Create</Button>
        </>
      }
    >
      <form id="new-board" onSubmit={create}>
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </form>
    </Dialog>
  );

  return (
    <AppShell
      brand="Canvas"
      sidebar={<SidebarNav label="Boards" items={[{ href: "#/", label: "All boards", current: board === null }, ...boards.map((b) => ({ href: `#/b/${encodeURIComponent(b.id)}`, label: b.title || b.id, current: b.id === board }))]} />}
      topbar={
        <>
          <Select label="Theme" hideLabel value={preference} onChange={(e) => setPreference(e.target.value as "system" | "light" | "dark")}>
            <option value="system">Theme: system</option>
            <option value="light">Theme: light</option>
            <option value="dark">Theme: dark</option>
          </Select>
          {me && <span className="who">{me.actor} ({me.kind.replace(/_/g, " ")}, {me.role})</span>}
          <Button variant="ghost" onClick={onSignOut}>Sign out</Button>
        </>
      }
    >
      {board !== null ? (
        me ? <BoardView key={board} id={board} token={token} me={me} /> : list.state === "error" ? <Failure message={list.message} retry={load} /> : <p role="status">Loading…</p>
      ) : (
        <section aria-labelledby="boards-h" aria-busy={list.state === "loading"}>
          <div className="row">
            <h1 id="boards-h">Boards</h1>
            {newBoard}
          </div>
          {list.state === "loading" && <p role="status">Loading boards…</p>}
          {list.state === "error" && <Failure message={list.message} retry={load} />}
          {list.state === "ready" && boards.length === 0 && (
            <EmptyState title="No boards yet" description={canWrite ? "Make a board to start drawing." : "This token can read boards but not make one."} />
          )}
          {list.state === "ready" && boards.length > 0 && (
            <ul className="boards">
              {boards.map((b) => (
                <li key={b.id}><a href={`#/b/${encodeURIComponent(b.id)}`}>{b.title || b.id}</a></li>
              ))}
            </ul>
          )}
        </section>
      )}
    </AppShell>
  );
}

export function App() {
  const [token, setValue] = useState<string | null>(getToken());
  if (!token) return <SignIn onSignedIn={setValue} />;
  return <Workspace token={token} onSignOut={() => (setToken(null), setValue(null))} />;
}
