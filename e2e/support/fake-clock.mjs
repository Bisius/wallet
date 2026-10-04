/**
 * A Node preload that gives the Wallet server a clock the E2E tests can move:
 *
 *     node --import ./e2e/support/fake-clock.mjs backend/dist/index.js
 *
 * The backend reads "now" only from its injected `Clock`, and `systemClock` is `new Date()`, so
 * replacing the global `Date` is enough to drive the real production build (month closing, savings
 * due, "today" for the UI) without a time-travel backdoor in the app itself.
 *
 * The replacement is "real time plus an offset": `new Date()`, `Date()` and `Date.now()` answer
 * `realNow + offset`, so the clock keeps ticking from the instant it was set to. Everything else is
 * the real `Date`: it is a Proxy around it, so `new Date(2026, 2, 10)`, `Date.UTC`, `Date.parse`,
 * `instanceof Date`, subclassing, `toISOString` and the rest behave as usual.
 *
 * Environment:
 *   WALLET_E2E_NOW           initial instant, anything `Date.parse` reads. Zone-less means the
 *                            server's local time, so run the server with `TZ=UTC` (the harness does).
 *   WALLET_E2E_CLOCK_SOCKET  path of a unix domain socket on which the clock can be read and moved
 *                            while the server runs. One JSON object per connection:
 *                              {"cmd":"get"}                        -> {"ok":true,"now":"<ISO UTC>"}
 *                              {"cmd":"set","now":"2026-04-01T09:00:00"} -> {"ok":true,"now":"<ISO UTC>"}
 *                            A bad request answers {"ok":false,"error":"..."}.
 *
 * The socket server is `unref()`ed, so it never keeps the process alive.
 */
import { unlinkSync } from 'node:fs';
import net from 'node:net';

const RealDate = globalThis.Date;
// Captured before the replacement: the one real clock read.
const realNow = () => RealDate.now();

let offsetMs = 0;
const fakeNowMs = () => realNow() + offsetMs;

function parseInstant(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('expected an ISO date-time string');
  }
  const ms = RealDate.parse(text);
  if (Number.isNaN(ms)) throw new Error(`"${text}" is not a date-time`);
  return ms;
}

function moveTo(text) {
  offsetMs = parseInstant(text) - realNow();
}

const initial = process.env.WALLET_E2E_NOW;
if (initial) {
  try {
    moveTo(initial);
  } catch (error) {
    console.error(`fake-clock: WALLET_E2E_NOW is invalid: ${error.message}`);
    process.exit(1);
  }
}

/** `Date.now()`, as a named function so that it still prints as `[Function: now]`. */
function now() {
  return fakeNowMs();
}

const FakeDate = new Proxy(RealDate, {
  // `new Date()` and `super()` without arguments read the clock; with arguments they are the real thing.
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length === 0 ? [fakeNowMs()] : args, newTarget);
  },
  // `Date()` called as a function returns the current time as a string.
  apply() {
    return new RealDate(fakeNowMs()).toString();
  },
  get(target, property) {
    if (property === 'now') return now;
    return Reflect.get(target, property, target);
  },
});

// `new Date().constructor === Date` keeps holding.
Object.defineProperty(RealDate.prototype, 'constructor', {
  value: FakeDate,
  writable: true,
  configurable: true,
  enumerable: false,
});
Object.defineProperty(globalThis, 'Date', {
  value: FakeDate,
  writable: true,
  configurable: true,
  enumerable: false,
});

const socketPath = process.env.WALLET_E2E_CLOCK_SOCKET;
if (socketPath) {
  const reply = (socket, body) => socket.end(`${JSON.stringify(body)}\n`);

  const handle = (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return { ok: false, error: 'the request is not JSON' };
    }
    try {
      if (request?.cmd === 'set') moveTo(request.now);
      else if (request?.cmd !== 'get') throw new Error(`unknown command "${request?.cmd}"`);
      return { ok: true, now: new RealDate(fakeNowMs()).toISOString() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };

  const removeSocketFile = () => {
    try {
      unlinkSync(socketPath);
    } catch {
      // Already gone.
    }
  };

  // A server that was killed leaves its socket file behind, and listening on it again fails.
  removeSocketFile();
  const server = net.createServer((socket) => {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      buffered += chunk;
      const end = buffered.indexOf('\n');
      if (end !== -1) reply(socket, handle(buffered.slice(0, end)));
    });
  });
  server.on('error', (error) => {
    console.error(`fake-clock: cannot listen on ${socketPath}: ${error.message}`);
    process.exit(1);
  });
  server.listen(socketPath);
  server.unref();
  process.on('exit', removeSocketFile);
}
