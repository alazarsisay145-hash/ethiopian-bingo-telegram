import { errorDtoSchema } from '@bingo/shared';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function createApi(
  baseUrl: string,
  getInitData: () => string,
  fetcher: typeof fetch = fetch,
) {
  return {
    async request<T>(path: string, schema: z.ZodType<T>, options: RequestInit = {}): Promise<T> {
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
        throw new ApiError('INVALID_REQUEST', 0, 'Expected a relative API path');
      }
      const base = new URL(baseUrl);
      const url = new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base.origin);
      if (url.origin !== base.origin)
        throw new ApiError('INVALID_REQUEST', 0, 'Expected a same-origin API path');
      const raw = getInitData();
      if (!raw) throw new ApiError('UNAUTHENTICATED', 0, 'Telegram authentication is required');
      const headers = new Headers(options.headers);
      headers.set('Authorization', `tma ${raw}`);
      headers.set('Accept', 'application/json');
      if (options.body && !headers.has('Content-Type'))
        headers.set('Content-Type', 'application/json');
      let response: Response;
      try {
        response = await fetcher(url, {
          ...options,
          headers,
          credentials: 'omit',
          redirect: 'error',
        });
      } catch {
        throw new ApiError(
          options.signal?.aborted ? 'REQUEST_ABORTED' : 'NETWORK_ERROR',
          0,
          'Request could not be completed',
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ApiError(
          'INVALID_RESPONSE',
          response.status,
          'Server returned an invalid response',
        );
      }
      if (!response.ok) {
        const parsed = errorDtoSchema.safeParse(body);
        if (!parsed.success)
          throw new ApiError(
            'INVALID_RESPONSE',
            response.status,
            'Server returned an invalid error',
          );
        const { error } = parsed.data;
        throw new ApiError(
          error.code,
          response.status,
          error.message,
          error.details,
          error.requestId,
        );
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success)
        throw new ApiError(
          'INVALID_RESPONSE',
          response.status,
          'Server response did not match its contract',
        );
      return parsed.data;
    },
  };
}
