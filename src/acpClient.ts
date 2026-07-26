/**
 * ACP (Agent Client Protocol) client.
 * Speaks JSON-RPC 2.0 over a `hermes acp` stdio subprocess.
 *
 * Wire format: newline-delimited JSON
 * Method names: slash-delimited (session/new, session/prompt, …)
 * Params/result fields: camelCase aliases from the Pydantic schema
 *
 * Incoming message types:
 *   - Response to our request     → { jsonrpc, id, result|error }
 *   - Notification from agent     → { jsonrpc, method, params }   (no id)
 *   - Request from agent to us    → { jsonrpc, id, method, params }  (we must reply)
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

export type IncomingRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

export type NotificationHandler = (method: string, params: unknown) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export interface AcpSessionInfo {
  session_id: string;
  cwd: string;
  title?: string;
  updated_at?: string;
}

export class AcpClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private buffer = '';
  private notificationHandler: NotificationHandler | null = null;
  private requestHandler: IncomingRequestHandler | null = null;

  constructor(
    private hermesPath: string,
    private readonly envOverrides: NodeJS.ProcessEnv = {},
    private readonly debugLogging = false,
  ) {
    super();
  }

  setHermesPath(nextPath: string): void {
    if (this.proc) return;
    this.hermesPath = nextPath;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** Handle requests sent FROM the agent TO us (e.g. session/request_permission). */
  onIncomingRequest(handler: IncomingRequestHandler): void {
    this.requestHandler = handler;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    this.emit('log', `[acp] spawn ${this.hermesPath} acp`);
    this.proc = spawn(this.hermesPath, ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.envOverrides },
    });

    this.proc.stdout!.setEncoding('utf8');
    this.proc.stdout!.on('data', (chunk: string) => this.onData(chunk));

    this.proc.stderr!.setEncoding('utf8');
    this.proc.stderr!.on('data', (line: string) => {
      this.emit('log', line.trimEnd());
    });

    this.proc.on('error', (err) => {
      this.emit('log', `[acp] spawn error: ${err.message}`);
      this.emit('exit', -1);
      this.proc = null;
      for (const [, req] of this.pending) {
        req.reject(new Error(`Failed to start hermes: ${err.message}`));
      }
      this.pending.clear();
    });

    this.proc.on('exit', (code) => {
      this.emit('exit', code);
      this.proc = null;
      for (const [, req] of this.pending) {
        req.reject(new Error(`hermes acp exited (code ${code})`));
      }
      this.pending.clear();
    });

    // Handshake — protocolVersion is integer 1, params use camelCase
    await this.call('initialize', { protocolVersion: 1 });
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }

  async call(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) throw new Error('ACP client not started');

    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    this.emit('log', this.debugLogging
      ? `[acp] --> ${method} #${id} ${this.preview(params)}`
      : `[acp] --> ${method} #${id}`);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(message);
    });
  }

  /** Send a fire-and-forget notification (no id, no response expected). */
  notify(method: string, params: unknown): void {
    if (!this.proc) return;
    const message = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.emit('log', this.debugLogging
      ? `[acp] ~~> ${method} ${this.preview(params)}`
      : `[acp] ~~> ${method}`);
    this.proc.stdin!.write(message);
  }

  private reply(id: number | string, result: unknown): void {
    const message = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
    this.proc?.stdin?.write(message);
  }

  private replyError(id: number | string, code: number, message: string): void {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    }) + '\n';
    this.proc?.stdin?.write(payload);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (this.debugLogging) {
        this.emit('log', `[acp raw] ${trimmed.slice(0, 500)}`);
      }
      try {
        this.dispatch(JSON.parse(trimmed));
      } catch {
        this.emit('log', '[acp] failed to parse JSON line');
        // Ignore malformed lines
      }
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    if (msg.id !== undefined && msg.method) {
      // Incoming request from agent (e.g. session/request_permission)
      this.handleIncomingRequest(msg);
    } else if (msg.id !== undefined) {
      // Response to one of our call()s
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);

      if (msg.error) {
        const err = msg.error as { message: string; code: number };
        this.emit('log', `[acp] <-- #${msg.id} ERROR ${err.code}: ${err.message}`);
        pending.reject(new Error(`ACP error ${err.code}: ${err.message}`));
      } else {
        this.emit('log', this.debugLogging
          ? `[acp] <-- #${msg.id} OK ${this.preview(msg.result)}`
          : `[acp] <-- #${msg.id} OK`);
        pending.resolve(msg.result);
      }
    } else if (msg.method) {
      // Notification (no id)
      this.emit('log', this.debugLogging
        ? `[acp] <-- ${msg.method} ${this.preview(msg.params)}`
        : `[acp] <-- ${msg.method}`);
      this.notificationHandler?.(msg.method as string, msg.params);
    }
  }

  private preview(value: unknown): string {
    try {
      const text = JSON.stringify(value);
      if (!text) return '';
      return text.length > 400 ? `${text.slice(0, 400)}…` : text;
    } catch {
      return '[unserializable]';
    }
  }

  private handleIncomingRequest(msg: Record<string, unknown>): void {
    const id = msg.id as number | string;
    const method = msg.method as string;
    const params = msg.params;

    if (this.requestHandler) {
      this.requestHandler(method, params)
        .then((result) => this.reply(id, result))
        .catch((err: Error) => this.replyError(id, -32603, err.message));
    } else {
      this.replyError(id, -32601, `No handler for ${method}`);
    }
  }

  /** List all ACP sessions from the server. */
  async listSessions(cwd?: string): Promise<AcpSessionInfo[]> {
    const result = await this.call('session/list', { cwd }) as { sessions: any[]; next_cursor?: string };
    if (!result?.sessions) return [];
    return result.sessions.map(s => ({
      session_id: s.sessionId || s.session_id,
      cwd: s.cwd,
      title: s.title,
      updated_at: s.updatedAt || s.updated_at
    }));
  }

  /** Get a single ACP session by ID. */
  async getSession(sessionId: string): Promise<AcpSessionInfo | null> {
    const result = await this.call('session/get', { sessionId }) as { session: any } | null;
    if (!result?.session) return null;
    const s = result.session;
    return {
      session_id: s.sessionId || s.session_id,
      cwd: s.cwd,
      title: s.title,
      updated_at: s.updatedAt || s.updated_at
    };
  }

  /** Create a new ACP session with initial history. */
  async createSessionWithHistory(messages: unknown[], cwd: string): Promise<string> {
    const result = await this.call('session/create_with_history', { messages, cwd }) as { sessionId?: string; session_id?: string };
    return result?.sessionId ?? result?.session_id ?? '';
  }
}