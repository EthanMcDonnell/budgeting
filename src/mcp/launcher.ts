import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

/*
 * Keeps the budget MCP server on the latest code. Claude Code starts this once per session and talks to
 * it over stdio (one JSON-RPC message per line). It runs the real server (server.ts) as a child and
 * restarts it whenever a file under src/ changes: calls in flight finish first, new ones wait, the
 * session's `initialize` is replayed to the new server, and Claude Code is told the tool list changed
 * so new tools appear. If the server crashes, the next call starts it again.
 *
 * Only plumbing lives here, so this file itself rarely changes (changes to it need /mcp to reconnect).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const SERVER = path.join(ROOT, 'src/mcp/server.ts');
/** The id of our replayed initialize, so its response isn't passed on to Claude Code. */
const REINIT = '__budget_reinit__';

type Id = string | number;
interface Message { id?: Id; method?: string; params?: unknown }

const log = (m: string) => process.stderr.write(`[budget-mcp] ${m}\n`);
const toClient = (msg: object) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const parse = (line: string): Message | null => { try { return JSON.parse(line) as Message; } catch { return null; } };

let initialize: Message | null = null; // Claude Code's handshake, replayed to each new server
let worker: ChildProcess | null = null;
let ready = false; // the current server has been initialised and can take calls
let restarting = false;
const queue: string[] = []; // calls waiting for a server
const pending = new Set<Id>(); // calls sent to the current server, awaiting a reply

function start() {
  const replay = initialize != null;
  const child = spawn(process.execPath, [TSX, SERVER], { cwd: ROOT, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
  worker = child;
  ready = !replay; // the very first server gets Claude Code's own initialize from the queue
  pending.clear();

  readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    if (worker !== child) return;
    const msg = parse(line);
    if (!msg) return void process.stderr.write(`${line}\n`);
    if (msg.id === REINIT) {
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      ready = true;
      toClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      return flush();
    }
    if (msg.id != null && msg.method == null) pending.delete(msg.id);
    process.stdout.write(`${line}\n`);
    if (restarting && pending.size === 0) swap();
  });

  child.on('exit', (code, signal) => {
    if (worker !== child) return; // replaced on purpose
    log(`server stopped (${signal ?? code}); it restarts on the next call`);
    for (const id of pending) toClient({ jsonrpc: '2.0', id, error: { code: -32000, message: 'The budget server stopped while handling this; try again.' } });
    worker = null;
    ready = false;
    restarting = false;
    pending.clear();
    if (queue.length) start();
  });

  if (replay) child.stdin!.write(`${JSON.stringify({ ...initialize, id: REINIT })}\n`);
}

function flush() {
  while (ready && worker && !restarting && queue.length) {
    const line = queue.shift()!;
    const msg = parse(line);
    if (msg?.id != null && msg.method != null) pending.add(msg.id);
    worker.stdin!.write(`${line}\n`);
  }
}

/** Replaces the server once its calls are done. */
function swap() {
  const old = worker;
  restarting = false;
  worker = null;
  old?.kill();
  start();
  flush();
}

function restart() {
  if (!worker || !initialize) return; // nothing running yet; the next call starts on the latest code
  log('code changed; restarting the server');
  restarting = true;
  ready = false;
  if (pending.size === 0) swap();
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = parse(line);
  if (msg?.method === 'initialize') initialize = msg;
  queue.push(line);
  if (!worker) start();
  flush();
});
process.stdin.on('end', () => {
  worker?.kill();
  process.exit(0);
});

let timer: NodeJS.Timeout | undefined;
fs.watch(path.join(ROOT, 'src'), { recursive: true }, (_event, file) => {
  // The web server (src/server) isn't part of this process.
  if (!file || !file.endsWith('.ts') || file.startsWith(`server${path.sep}`)) return;
  clearTimeout(timer);
  timer = setTimeout(restart, 300);
});
