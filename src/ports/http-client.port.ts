/**
 * HTTP port.
 *
 * Sends GET requests and returns the response as text. An HTTP error status is a normal response
 * here: what a status means depends on the API (see `core/deadlock-api/api-response.ts`). Only the
 * failures of the transport itself are errors.
 *
 * Unlike the other ports, the adapters report those failures as `AppError`s: only the adapter can
 * tell a timeout from a network failure or an oversized response.
 *
 * @packageDocumentation
 */

/** A GET request. */
export interface HttpRequest {
  readonly url: string;
  /** Request headers, e.g. `User-Agent`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The whole request (connection, headers and body) is abandoned after this delay. */
  readonly timeoutMs: number;
  /** Largest body accepted, in bytes; reading stops as soon as it is exceeded. */
  readonly maxBodyBytes: number;
}

/** A response, whatever its status. */
export interface HttpResponse {
  readonly status: number;
  /** Response headers, with lower-case names. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body, decoded as UTF-8. */
  readonly body: string;
}

/** Sends HTTP requests. */
export interface HttpClient {
  /**
   * Send a GET request and read the whole response.
   *
   * @param request - The request.
   * @returns The response, whatever its status.
   * @throws AppError of kind `timeout` when `timeoutMs` elapsed, `network` when the server could
   *   not be reached or the connection failed, `invalid_payload` when the body exceeds
   *   `maxBodyBytes`.
   */
  get(request: HttpRequest): Promise<HttpResponse>;
}
