/**
 * Tests of the Tauri HTTP adapter, with a fake of the plugin's `fetch`.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import type { HttpRequest } from '../../ports/http-client.port';
import { TauriHttpClient, type FetchFunction } from './tauri-http-client.adapter';

/**
 * Build a request.
 *
 * @param overrides - Fields to change.
 * @returns The request.
 */
function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    url: 'https://api.deadlock-api.com/v1/assets/heroes',
    headers: { 'User-Agent': 'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)' },
    timeoutMs: 15_000,
    maxBodyBytes: 1_000,
    ...overrides,
  };
}

/**
 * A body streamed in chunks, without a declared length.
 *
 * @param chunks - The chunks, as text.
 * @returns The stream.
 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('TauriHttpClient', () => {
  it('sends a GET with the headers of the request and returns status, headers and body', async () => {
    const fetchFunction = vi.fn<FetchFunction>(() =>
      Promise.resolve(
        new Response('[{"id":67}]', { status: 200, headers: { 'Called-Steam': 'true' } }),
      ),
    );

    const response = await new TauriHttpClient(fetchFunction).get(request());

    expect(fetchFunction).toHaveBeenCalledWith(
      'https://api.deadlock-api.com/v1/assets/heroes',
      expect.objectContaining({
        method: 'GET',
        headers: { 'User-Agent': 'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)' },
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
    expect(response).toEqual({
      status: 200,
      headers: { 'called-steam': 'true', 'content-type': 'text/plain;charset=UTF-8' },
      body: '[{"id":67}]',
    });
  });

  it('returns error statuses as responses: their meaning belongs to the API rules', async () => {
    const client = new TauriHttpClient(() =>
      Promise.resolve(new Response('{"status":429}', { status: 429 })),
    );

    await expect(client.get(request())).resolves.toMatchObject({ status: 429 });
  });

  it('reads a body sent in several chunks', async () => {
    const client = new TauriHttpClient(() =>
      Promise.resolve(new Response(streamOf(['[1,', '2,', '3]']), { status: 200 })),
    );

    await expect(client.get(request())).resolves.toMatchObject({ body: '[1,2,3]' });
  });

  it('refuses a body whose declared length exceeds the limit', async () => {
    const client = new TauriHttpClient(() =>
      Promise.resolve(new Response('x', { status: 200, headers: { 'Content-Length': '5000' } })),
    );

    await expect(client.get(request())).rejects.toMatchObject({ kind: 'invalid_payload' });
  });

  it('stops reading a body that exceeds the limit without declaring its length', async () => {
    const client = new TauriHttpClient(() =>
      Promise.resolve(new Response(streamOf(['x'.repeat(600), 'x'.repeat(600)]), { status: 200 })),
    );

    await expect(client.get(request())).rejects.toMatchObject({
      kind: 'invalid_payload',
      context: { maxBodyBytes: 1_000 },
    });
  });

  it('reports a request that outlives its timeout as a timeout', async () => {
    // Like the plugin, the fake only gives up when the signal aborts.
    const client = new TauriHttpClient(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new Error('Request cancelled'));
          });
        }),
    );

    await expect(client.get(request({ timeoutMs: 20 }))).rejects.toMatchObject({
      kind: 'timeout',
      cause: new Error('Request cancelled'),
    });
  });

  it('reports any other failure as a network error and keeps its cause', async () => {
    const client = new TauriHttpClient(() =>
      Promise.reject(new Error('error sending request for url (https://api.deadlock-api.com/)')),
    );

    await expect(client.get(request())).rejects.toMatchObject({
      kind: 'network',
      cause: new Error('error sending request for url (https://api.deadlock-api.com/)'),
    });
  });
});
