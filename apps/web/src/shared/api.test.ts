import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApi } from './api';

describe('typed API', () => {
  const responseSchema = z.object({ value: z.number().int() });
  it('validates responses and uses actual Telegram credentials', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"value":4}', { status: 200 }));
    const api = createApi('https://api.example/api', () => 'actual-launch-data', fetcher);
    await expect(api.request('/value', responseSchema)).resolves.toEqual({ value: 4 });
    const options = fetcher.mock.calls[0]?.[1];
    expect(new Headers(options?.headers).get('Authorization')).toBe('tma actual-launch-data');
    expect(options?.redirect).toBe('error');
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://api.example/api/value');
  });

  it('rejects malformed success responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"value":"wrong"}'));
    await expect(
      createApi('https://api.example', () => 'raw', fetcher).request('/value', responseSchema),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', httpStatus: 200 });
  });

  it('preserves structured server errors without exposing them to logs', async () => {
    const body = {
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request', requestId: 'request-1' },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body), { status: 400 }));
    await expect(
      createApi('https://api.example', () => 'raw', fetcher).request('/value', responseSchema),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', httpStatus: 400, requestId: 'request-1' });
  });

  it('handles network errors without leaking sensitive messages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret'));
    await expect(
      createApi('https://api.example', () => 'raw', fetcher).request('/value', responseSchema),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: 'Request could not be completed' });
  });

  it.each(['//evil.example', 'https://evil.example', '/\\evil.example'])(
    'rejects external paths %s',
    async (path) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        createApi('https://api.example', () => 'raw', fetcher).request(path, responseSchema),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('never sends unauthenticated requests', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createApi('https://api.example', () => '', fetcher).request('/value', responseSchema),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('handles non-JSON and malformed error responses', async () => {
    for (const body of ['not JSON', '{"unexpected":true}']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status: 500 }));
      await expect(
        createApi('https://api.example', () => 'raw', fetcher).request('/value', responseSchema),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', httpStatus: 500 });
    }
  });
});
