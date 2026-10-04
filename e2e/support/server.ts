import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repository root: this file is `e2e/support/server.ts`. */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
/** The bundled production server (`npm run build`). */
export const BACKEND_ENTRY = join(REPO_ROOT, 'backend/dist/index.js');
/**
 * The built Angular app that the server serves in production. `PW_FRONTEND_DIST` (the `browser` folder
 * of a build made with `ng build --output-path <dir>`) points at another build, for runs that must
 * not share `frontend/dist` with a build in progress.
 */
export const FRONTEND_DIST = process.env['PW_FRONTEND_DIST']
  ? resolve(process.env['PW_FRONTEND_DIST'])
  : join(REPO_ROOT, 'frontend/dist/frontend/browser');
/** The preload that replaces `Date`, see `fake-clock.mjs`. */
export const FAKE_CLOCK_PRELOAD = join(REPO_ROOT, 'e2e/support/fake-clock.mjs');

const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;
/** A few attempts, in case the free port that was picked is taken before the server binds it. */
const START_ATTEMPTS = 4;
/** What of the server's output is kept for a failing test: the end of it. */
const LOG_LIMIT = 64 * 1024;

/**
 * One real Wallet server (the production build, `NODE_ENV=production`) in a private temp folder, with
 * its own database and backup folder, and a clock the test can move (see `fake-clock.mjs`).
 *
 * The server runs with `TZ=UTC` because "today" is the date in the server's local time zone, so a
 * zone-less instant such as `2026-03-10T09:00:00` means the same in every environment.
 *
 * The folder, the port and the clock survive `stop()` and `start()`: the same database comes back
 * on the same address, and the clock resumes at the instant it was stopped at.
 */
export class WalletServer {
  /** The private folder holding everything this server writes (it is also the server's cwd). */
  readonly dir: string;
  readonly dbPath: string;
  readonly backupDir: string;
  /** The instant the clock started at, as given. */
  readonly initialNow: string;

  private readonly clockSocket: string;
  private port: number | undefined;
  private child: ChildProcess | undefined;
  private clockNow: string;
  private output = '';

  private constructor(dir: string, initialNow: string) {
    this.dir = dir;
    this.dbPath = join(dir, 'wallet.db');
    this.backupDir = join(dir, 'backups');
    this.clockSocket = join(dir, 'clock.sock');
    this.initialNow = initialNow;
    this.clockNow = initialNow;
  }

  /** Makes the folder and starts the server in it. */
  static async start(initialNow: string): Promise<WalletServer> {
    // A short prefix: a unix socket path has a length limit (about 100 characters).
    const server = new WalletServer(await mkdtemp(join(tmpdir(), 'wallet-e2e-')), initialNow);
    try {
      await server.start();
    } catch (error) {
      await server.remove();
      throw error;
    }
    return server;
  }

  get baseURL(): string {
    if (this.port === undefined) throw new Error('The Wallet server has not been started');
    return `http://127.0.0.1:${this.port}`;
  }

  get running(): boolean {
    return this.child !== undefined;
  }

  /** What the server printed so far (the end of it). */
  log(): string {
    return this.output;
  }

  /** Starts the server again after `stop()`, on the same folder, port and clock. */
  async start(): Promise<void> {
    if (this.child) throw new Error('The Wallet server is already running');
    for (let attempt = 1; ; attempt++) {
      // Only the very first start chooses the port: a restart must come back on the same address.
      const port = this.port ?? (await freePort());
      try {
        await this.spawnOn(port);
        this.port = port;
        return;
      } catch (error) {
        const portTaken = error instanceof PortTakenError;
        if (!portTaken || this.port !== undefined || attempt === START_ATTEMPTS) throw error;
      }
    }
  }

  /** Stops the server with SIGTERM, as a service manager does, and waits for it to exit. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    // Remember the clock, so that start() resumes where it was (not at the initial instant).
    this.clockNow = await this.getNow().catch(() => this.clockNow);
    const exited = onceExited(child);
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
      this.child = undefined;
    }
  }

  /**
   * Ends the server with SIGKILL: no clean shutdown, so SQLite never checkpoints or deletes its
   * `-wal` and `-shm` files. It is what a crash, a power cut or `docker kill` leaves behind, and what
   * `stop()` never does. `start()` brings it back, with the clock where it was.
   */
  async kill(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.clockNow = await this.getNow().catch(() => this.clockNow);
    const exited = onceExited(child);
    child.kill('SIGKILL');
    try {
      await exited;
    } finally {
      this.child = undefined;
    }
  }

  /** Stops the server (if it runs) and deletes its folder. */
  async remove(): Promise<void> {
    await this.stop();
    await rm(this.dir, { recursive: true, force: true });
  }

  /**
   * Moves the fake clock. A zone-less instant is in the server's local time zone, which is UTC; one
   * with `Z` or an offset is taken as written. The clock keeps ticking from there.
   */
  async setNow(instant: string): Promise<void> {
    await this.askClock({ cmd: 'set', now: instant });
  }

  /** The fake clock's current instant, as an ISO string in UTC. */
  async getNow(): Promise<string> {
    return this.askClock({ cmd: 'get' });
  }

  // --- internals -------------------------------------------------------------------------------

  private async spawnOn(port: number): Promise<void> {
    this.append(`\n--- starting on port ${port} ---\n`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      TZ: 'UTC',
      DATABASE_PATH: this.dbPath,
      BACKUP_DIR: this.backupDir,
      WALLET_E2E_NOW: this.clockNow,
      WALLET_E2E_CLOCK_SOCKET: this.clockSocket,
    };
    // The built app is found next to the backend by default; a variable of the caller's shell must not
    // redirect it (only `PW_FRONTEND_DIST` does).
    if (process.env['PW_FRONTEND_DIST']) env['STATIC_DIR'] = FRONTEND_DIST;
    else delete env['STATIC_DIR'];

    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(FAKE_CLOCK_PRELOAD).href, BACKEND_ENTRY],
      { cwd: this.dir, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;
    const exited = onceExited(child);
    // A server that dies on its own is not "running" any more.
    void exited.then(() => {
      if (this.child === child) this.child = undefined;
    });
    const listening = `Wallet listening on http://127.0.0.1:${port} `;
    let ready: () => void = () => undefined;
    const sawListening = new Promise<void>((resolve) => (ready = resolve));
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.append(chunk);
      stdout += chunk;
      if (stdout.includes(listening)) ready();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => this.append(chunk));

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no "${listening.trim()}" after ${START_TIMEOUT_MS} ms`)),
        START_TIMEOUT_MS,
      );
    });
    try {
      // The server's own "listening" line proves that it, and not another program, owns the port.
      const outcome = await Promise.race([
        sawListening.then(() => 'listening' as const),
        exited.then(() => 'exited' as const),
        timeout,
      ]);
      if (outcome === 'exited') {
        const taken = /EADDRINUSE|Cannot listen/.test(this.output);
        const message = `The Wallet server exited while starting:\n${this.output}`;
        throw taken ? new PortTakenError(message) : new Error(message);
      }
      await this.waitForHealth(port);
      await this.getNow().catch((error: unknown) => {
        throw new Error(`The fake clock does not answer (${String(error)}):\n${this.output}`);
      });
    } catch (error) {
      await this.stop();
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForHealth(port: number): Promise<void> {
    const url = `http://127.0.0.1:${port}/api/health`;
    const deadline = Date.now() + START_TIMEOUT_MS;
    for (;;) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return;
      } catch {
        // Not accepting connections yet.
      }
      if (Date.now() > deadline) {
        throw new Error(`${url} did not answer in time:\n${this.output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private append(text: string): void {
    this.output = (this.output + text).slice(-LOG_LIMIT);
  }

  private askClock(command: { cmd: 'get' } | { cmd: 'set'; now: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.clockSocket);
      let body = '';
      socket.setEncoding('utf8');
      socket.setTimeout(5000, () => socket.destroy(new Error('the fake clock did not answer')));
      socket.on('data', (chunk: string) => (body += chunk));
      socket.on('error', reject);
      socket.on('close', () => {
        try {
          const answer = JSON.parse(body) as { ok: boolean; now?: string; error?: string };
          if (answer.ok && answer.now) resolve(answer.now);
          else reject(new Error(`fake clock ${command.cmd} failed: ${answer.error ?? body}`));
        } catch {
          reject(new Error(`fake clock ${command.cmd} gave no valid answer: "${body}"`));
        }
      });
      socket.write(`${JSON.stringify(command)}\n`);
    });
  }
}

class PortTakenError extends Error {}

function onceExited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
}

/** Asks the OS for a free port: bind port 0 and read it back. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      probe.close(() => (port === undefined ? reject(new Error('no port')) : resolve(port)));
    });
  });
}
