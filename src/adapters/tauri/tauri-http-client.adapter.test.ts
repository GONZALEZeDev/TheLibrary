/**
 * Tests of the Tauri HTTP adapter, with a fake of the plugin's `fetch`.
 *
 * @packageDocumentation
 */
import { describe, expect, it, vi } from 'vitest';
import type { HttpFormPost, HttpRequest } from '../../ports/http-client.port';
import { TauriHttpClient, type FetchFunction } from './tauri-http-client.adapter';

const USER_AGENT = 'TheLibrary/0.1.0 (+https://github.com/GONZALEZeDev/TheLibrary)';

/** A synthetic form body: the real one carries what Steam sent back to the app. */
const FORM = 'openid.mode=check_authentication&openid.sig=synthetic';

/** The start of a JPEG file: not valid UTF-8, so only a byte-exact read gets it back. */
const JPEG_START = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/**
 * Build a request.
 *
 * @param overrides - Fields to change.
 * @returns The request.
 */
function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    url: 'https://api.deadlock-api.com/v1/assets/heroes',
    headers: { 'User-Agent': USER_AGENT },
    timeoutMs: 15_000,
    maxBodyBytes: 1_000,
    ...overrides,
  };
}

/**
 * Build a form post.
 *
 * @param overrides - Fields to change.
 * @returns The request.
 */
function formPost(overrides: Partial<HttpFormPost> = {}): HttpFormPost {
  return {
    ...request({ url: 'https://steamcommunity.com/openid/login' }),
    form: FORM,
    ...overrides,
  };
}

/**
 * A body streamed in chunks, without a declared length.
 *
 * @param chunks - The chunks, as bytes.
 * @returns The stream.
 */
function streamOfBytes(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

/**
 * A body streamed in chunks of text, without a declared length.
 *
 * @param chunks - The chunks, as text.
 * @returns The stream.
 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return streamOfBytes(chunks.map((chunk) => encoder.encode(chunk)));
}

/**
 * A `fetch` that only gives up when its signal aborts, like the plugin.
 *
 * @returns The fake.
 */
function hangingFetch(): FetchFunction {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        reject(new Error('Request cancelled'));
      });
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
        headers: { 'User-Agent': USER_AGENT },
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
    const client = new TauriHttpClient(hangingFetch());

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

  it('does not set a Content-Type or a redirect limit on a GET', async () => {
    const fetchFunction = vi.fn<FetchFunction>(() => Promise.resolve(new Response('[]')));

    await new TauriHttpClient(fetchFunction).get(request());

    expect(fetchFunction).toHaveBeenCalledWith('https://api.deadlock-api.com/v1/assets/heroes', {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      signal: expect.any(AbortSignal) as AbortSignal,
    });
  });
});

describe('TauriHttpClient.postForm', () => {
  it('posts a form without following redirects', async () => {
    const fetchFunction = vi.fn<FetchFunction>(() =>
      Promise.resolve(new Response('is_valid:true\n', { status: 200 })),
    );

    const response = await new TauriHttpClient(fetchFunction).postForm(formPost());

    expect(fetchFunction).toHaveBeenCalledWith('https://steamcommunity.com/openid/login', {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: FORM,
      maxRedirections: 0,
      signal: expect.any(AbortSignal) as AbortSignal,
    });
    expect(response).toEqual({
      status: 200,
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: 'is_valid:true\n',
    });
  });

  it('replaces a Content-Type of the request, whatever the case of its name', async () => {
    const fetchFunction = vi.fn<FetchFunction>(() => Promise.resolve(new Response('')));

    await new TauriHttpClient(fetchFunction).postForm(
      formPost({ headers: { 'User-Agent': USER_AGENT, 'content-type': 'text/plain' } }),
    );

    expect(fetchFunction).toHaveBeenCalledWith(
      'https://steamcommunity.com/openid/login',
      expect.objectContaining({
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }),
    );
  });

  it('returns a redirect of a form post as it is', async () => {
    const client = new TauriHttpClient(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://steamcommunity.com/openid/elsewhere' },
        }),
      ),
    );

    await expect(client.postForm(formPost())).resolves.toEqual({
      status: 302,
      headers: { location: 'https://steamcommunity.com/openid/elsewhere' },
      body: '',
    });
  });

  it('reports a timeout of a form post', async () => {
    const client = new TauriHttpClient(hangingFetch());

    await expect(client.postForm(formPost({ timeoutMs: 20 }))).rejects.toMatchObject({
      kind: 'timeout',
      cause: new Error('Request cancelled'),
    });
  });

  it('refuses a response over the limit', async () => {
    const client = new TauriHttpClient(() =>
      Promise.resolve(new Response(streamOf(['x'.repeat(600), 'x'.repeat(600)]), { status: 200 })),
    );

    await expect(client.postForm(formPost())).rejects.toMatchObject({
      kind: 'invalid_payload',
      context: { maxBodyBytes: 1_000 },
    });
  });
});

describe('TauriHttpClient.getBytes', () => {
  it('reads a binary body as bytes', async () => {
    const fetchFunction = vi.fn<FetchFunction>(() =>
      Promise.resolve(
        new Response(streamOfBytes([JPEG_START.slice(0, 2), JPEG_START.slice(2)]), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      ),
    );

    const response = await new TauriHttpClient(fetchFunction).getBytes(
      request({ url: 'https://avatars.steamstatic.com/synthetic_full.jpg' }),
    );

    expect(fetchFunction).toHaveBeenCalledWith(
      'https://avatars.steamstatic.com/synthetic_full.jpg',
      {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        signal: expect.any(AbortSignal) as AbortSignal,
      },
    );
    expect(response).toEqual({
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
      body: JPEG_START,
    });
  });

  it('returns an empty body as no bytes', async () => {
    const client = new TauriHttpClient(() => Promise.resolve(new Response(null, { status: 404 })));

    await expect(client.getBytes(request())).resolves.toEqual({
      status: 404,
      headers: {},
      body: new Uint8Array(0),
    });
  });

  it('refuses a binary body over the limit', async () => {
    const declared = new TauriHttpClient(() =>
      Promise.resolve(new Response('x', { status: 200, headers: { 'Content-Length': '5000' } })),
    );
    const undeclared = new TauriHttpClient(() =>
      Promise.resolve(
        new Response(streamOfBytes([new Uint8Array(600), new Uint8Array(600)]), { status: 200 }),
      ),
    );

    await expect(declared.getBytes(request())).rejects.toMatchObject({ kind: 'invalid_payload' });
    await expect(undeclared.getBytes(request())).rejects.toMatchObject({
      kind: 'invalid_payload',
      context: { maxBodyBytes: 1_000 },
    });
  });

  it('reports a timeout', async () => {
    const client = new TauriHttpClient(hangingFetch());

    await expect(client.getBytes(request({ timeoutMs: 20 }))).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});

describe('TauriHttpClient transport failures', () => {
  const methods = {
    get: (client: TauriHttpClient) => client.get(request()),
    postForm: (client: TauriHttpClient) => client.postForm(formPost()),
    getBytes: (client: TauriHttpClient) => client.getBytes(request()),
  };

  it.each(Object.entries(methods))(
    'reports a failure of %s as a network error and keeps its cause',
    async (_name, send) => {
      const client = new TauriHttpClient(() =>
        Promise.reject(new Error('error sending request for url (https://example.test/)')),
      );

      await expect(send(client)).rejects.toMatchObject({
        kind: 'network',
        cause: new Error('error sending request for url (https://example.test/)'),
      });
    },
  );

  it.each(Object.entries(methods))(
    'reports a body of %s that breaks while it is read as a network error',
    async (_name, send) => {
      const failing = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10));
          controller.error(new Error('connection reset'));
        },
      });
      const client = new TauriHttpClient(() => Promise.resolve(new Response(failing)));

      await expect(send(client)).rejects.toMatchObject({ kind: 'network' });
    },
  );
});
