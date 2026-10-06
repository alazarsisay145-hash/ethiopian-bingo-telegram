import { z } from 'zod';

const serverUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
}, 'Expected an HTTP(S) server URL without credentials, query, or fragment');

export function readEnvironment(input: Record<string, unknown>, origin: string) {
  const environment = z.object({
    VITE_API_BASE_URL: serverUrl.optional(),
    VITE_SOCKET_URL: serverUrl.optional(),
  }).parse(input);
  return {
    apiBaseUrl: environment.VITE_API_BASE_URL ?? origin,
    socketUrl: environment.VITE_SOCKET_URL ?? environment.VITE_API_BASE_URL ?? origin,
  };
}
