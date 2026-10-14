/**
 * {@link HttpClient} backed by the Tauri HTTP plugin (desktop app).
 *
 * The plugin sends the request from the Rust side, which is why the webview's strict CSP does not
 * have to allow deadlock-api: the hosts the app may reach are listed in
 * `src-tauri/capabilities/default.json`, and every redirect is checked against that list
 * (`plugins.http.scopeRedirects` in `tauri.conf.json`).
 *
 * The plugin has no overall timeout and no size limit of its own: the timeout is an
 * `AbortSignal`, and the body is read chunk by chunk and abandoned as soon as it is too large.
 *
 * @packageDocumentation
 */
import { fetch as pluginFetch } from '@tauri-apps/plugin-http';
import { AppError, isAppError } from '../../core/errors/app-error';
import type { HttpClient, HttpRequest, HttpResponse } from '../../ports/http-client.port';

/** The part of the plugin's `fetch` this adapter uses; tests pass a fake. */
export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

/** {@link HttpClient} sending requests through `@tauri-apps/plugin-http`. */
export class TauriHttpClient implements HttpClient {
  readonly #fetch: FetchFunction;

  /**
   * @param fetchFunction - The plugin's `fetch`; replaced by a fake in tests.
   */
  constructor(fetchFunction: FetchFunction = pluginFetch) {
    this.#fetch = fetchFunction;
  }

  /**
   * Send a GET request and read the whole response.
   *
   * @param request - The request.
   * @returns The response, whatever its status.
   * @throws AppError of kind `timeout`, `network` or `invalid_payload` (body too large).
   */
  async get(request: HttpRequest): Promise<HttpResponse> {
    // Covers the whole exchange: connection, headers and every chunk of the body.
    const signal = AbortSignal.timeout(request.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(request.url, {
        method: 'GET',
        headers: request.headers,
        signal,
      });
    } catch (error) {
      throw transportError(error, signal);
    }
    // `Headers` already gives lower-case names.
    const headers = Object.fromEntries(response.headers.entries());
    // A declared size over the limit is refused before a single byte is read.
    const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);
    if (declaredLength > request.maxBodyBytes) {
      await response.body?.cancel();
      throw tooLarge(request.maxBodyBytes);
    }
    const body = await readBody(response, request.maxBodyBytes, signal);
    return { status: response.status, headers, body };
  }
}

/**
 * Read a response body as UTF-8 text, stopping as soon as it exceeds the limit.
 *
 * @param response - The response.
 * @param maxBytes - Largest body accepted.
 * @param signal - Signal of the request, to tell a timeout from a network failure.
 * @returns The body text.
 * @throws AppError of kind `invalid_payload` when the body is too large, `timeout` or `network`
 *   when reading fails.
 */
async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    throw isAppError(error) ? error : transportError(error, signal);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Describe a failed exchange: the only abort source is the timeout, so an aborted signal means the
 * request took too long; anything else is a network failure (the plugin rejects with a plain
 * message, e.g. "error sending request for url (…)").
 *
 * @param cause - What the plugin rejected with.
 * @param signal - Signal of the request.
 * @returns The error to throw.
 */
function transportError(cause: unknown, signal: AbortSignal): AppError {
  return signal.aborted
    ? new AppError('timeout', 'The request timed out', { cause })
    : new AppError('network', 'The request failed', { cause });
}

/**
 * Error of a body over the size limit.
 *
 * @param maxBytes - The limit.
 * @returns The error to throw.
 */
function tooLarge(maxBytes: number): AppError {
  return new AppError('invalid_payload', 'The response body exceeds the size limit', {
    context: { maxBodyBytes: maxBytes },
  });
}
