import type { APIRequestContext, APIResponse } from '@playwright/test';

/**
 * A request to the Wallet API that answered with a non-2xx status. The message names the request,
 * the status and the body, so a failing seed call reads like the API's own error:
 *
 *     POST /api/budgets -> 422 Unprocessable Entity
 *       request:  {"name":"Rent","amount":-1,"incremental":false}
 *       response: {"error":{"code":"rule_violation","message":"...","details":{"rule":"before_start_month"}}}
 */
export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  readonly method: string;
  readonly url: string;
  readonly status: number;
  /** The `error.code` of the API's error body (`already_onboarded`, `rule_violation`, ...), if it has one. */
  readonly code: string | undefined;
  /** For `rule_violation`: the `error.details.rule`. */
  readonly rule: string | undefined;

  constructor(method: string, url: string, response: APIResponse, body: string, sent: unknown) {
    super(describeFailure(method, url, response, body, sent));
    const error = parseError(body);
    this.method = method;
    this.url = url;
    this.status = response.status();
    this.code = error?.code;
    this.rule = error?.details?.rule;
  }
}

function describeFailure(
  method: string,
  url: string,
  response: APIResponse,
  body: string,
  sent: unknown,
): string {
  const target = new URL(url);
  const request = sent === undefined ? '' : `\n  request:  ${clip(JSON.stringify(sent))}`;
  return (
    `${method} ${target.pathname}${target.search} -> ${response.status()} ${response.statusText()}` +
    `${request}\n  response: ${clip(body)}`
  );
}

const METHODS = new Set<string | symbol>([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'fetch',
]);

interface CallOptions {
  method?: string;
  data?: unknown;
  failOnStatusCode?: boolean;
}

/** A call before the status check: the Playwright method, with its `this` already bound. */
type Call = (url: string, options?: CallOptions) => Promise<APIResponse>;

/**
 * Wraps an `APIRequestContext` so that every request method (`get`, `post`, `put`, `patch`,
 * `delete`, `head`, `fetch`) throws an `ApiRequestError` on a status outside 2xx, with the response
 * body in the message. It is still an `APIRequestContext`: pass `{ failOnStatusCode: false }` to
 * a call to get the response of an expected error back instead (`expect(res.status()).toBe(409)`).
 *
 * `current` is read on every call, so the context behind it can be replaced (the harness does that
 * when the server restarts, so that no connection of the old process is reused).
 */
export function withReadableErrors(current: () => APIRequestContext): APIRequestContext {
  return new Proxy(current(), {
    get(_target, property) {
      const context = current();
      const value: unknown = Reflect.get(context, property, context);
      if (typeof value !== 'function') return value;
      const call = value.bind(context) as Call;
      if (!METHODS.has(property)) return call;

      return async (url: string, options?: CallOptions): Promise<APIResponse> => {
        const response = await call(url, options);
        if (response.ok() || options?.failOnStatusCode === false) return response;
        const method = (property === 'fetch' ? options?.method : String(property)) ?? 'GET';
        throw new ApiRequestError(
          method.toUpperCase(),
          response.url(),
          response,
          await response.text(),
          options?.data,
        );
      };
    },
  });
}

/** The JSON body of a response, typed by the caller (the API's DTOs live in `@wallet/shared`). */
export async function json<T>(response: APIResponse): Promise<T> {
  return (await response.json()) as T;
}

function parseError(body: string): { code?: string; details?: { rule?: string } } | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; details?: { rule?: string } } };
    return parsed.error;
  } catch {
    return undefined;
  }
}

function clip(text: string, limit = 600): string {
  return text.length > limit ? `${text.slice(0, limit)}... (${text.length} characters)` : text;
}
