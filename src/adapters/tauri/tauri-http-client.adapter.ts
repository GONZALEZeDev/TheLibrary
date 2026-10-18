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
 * The three methods share that exchange, so a timeout, a network failure or an oversized body is
 * reported the same way whatever the request.
 *
 * @packageDocumentation
 */
import { fetch as pluginFetch } from '@tauri-apps/plugin-http';
import { AppError, isAppError } from '../../core/errors/app-error';
import type {
  HttpBytesResponse,
  HttpClient,
  HttpFormPost,
  HttpRequest,
  HttpResponse,
} from '../../ports/http-client.port';

/**
 * The part of the plugin's `fetch` this adapter uses; tests pass a fake. `maxRedirections` is the
 * plugin's own option: with 0 a 3xx answer is returned as it is instead of being followed.
 */
export type FetchFunction = (
  url: string,
  init: RequestInit & { maxRedirections?: number },
) => Promise<Response>;

/** What differs between the methods in the call to `fetch`; the signal is added by the exchange. */
type SentRequest = Omit<RequestInit, 'signal'> & { maxRedirections?: number };

/** The `Content-Type` of a form body. */
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

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
    const response = await this.#exchange(request, { method: 'GET', headers: request.headers });
    return { ...response, body: new TextDecoder().decode(response.body) };
  }

  /**
   * Post a form and read the whole response. No redirect is followed (`maxRedirections: 0`): the
   * caller has to see a 3xx answer as it is, not the answer of the page it leads to.
   *
   * @param request - The request, with the form as its body.
   * @returns The response, whatever its status.
   * @throws AppError of kind `timeout`, `network` or `invalid_payload` (body too large).
   */
  async postForm(request: HttpFormPost): Promise<HttpResponse> {
    const response = await this.#exchange(request, {
      method: 'POST',
      headers: { ...withoutContentType(request.headers), 'Content-Type': FORM_CONTENT_TYPE },
      body: request.form,
      maxRedirections: 0,
    });
    return { ...response, body: new TextDecoder().decode(response.body) };
  }

  /**
   * Send a GET request and read the whole response as bytes.
   *
   * @param request - The request.
   * @returns The response, whatever its status.
   * @throws AppError of kind `timeout`, `network` or `invalid_payload` (body too large).
   */
  getBytes(request: HttpRequest): Promise<HttpBytesResponse> {
    return this.#exchange(request, { method: 'GET', headers: request.headers });
  }

  /**
   * Send a request and read the whole response, undecoded: the part every method shares.
   *
   * @param request - The limits of the exchange.
   * @param sent - What to send; the signal of the timeout is added to it.
   * @returns The response, whatever its status.
   * @throws AppError of kind `timeout`, `network` or `invalid_payload` (body too large).
   */
  async #exchange(request: HttpRequest, sent: SentRequest): Promise<HttpBytesResponse> {
    // Covers the whole exchange: connection, headers and every chunk of the body.
    const signal = AbortSignal.timeout(request.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(request.url, { ...sent, signal });
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
    const body = await readBytes(response, request.maxBodyBytes, signal);
    return { status: response.status, headers, body };
  }
}

/**
 * Copy headers without their `Content-Type`, whatever the case of its name: the form post sets its
 * own, and `fetch` would otherwise merge the two values into one invalid header.
 *
 * @param headers - Headers of the request.
 * @returns The other headers.
 */
function withoutContentType(
  headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type'),
  );
}

/**
 * Read a response body as bytes, stopping as soon as it exceeds the limit.
 *
 * @param response - The response.
 * @param maxBytes - Largest body accepted.
 * @param signal - Signal of the request, to tell a timeout from a network failure.
 * @returns The body; empty when the response has none.
 * @throws AppError of kind `invalid_payload` when the body is too large, `timeout` or `network`
 *   when reading fails.
 */
async function readBytes(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array(0);
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
  return bytes;
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
