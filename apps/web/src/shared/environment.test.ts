import { describe, expect, it } from 'vitest';
import { readEnvironment } from './environment';

describe('VITE environment', () => {
  it('uses same-origin defaults and ignores non-VITE configuration', () => {
    expect(
      readEnvironment({ API_BASE_URL: 'https://ignored.example' }, 'https://app.example'),
    ).toEqual({ apiBaseUrl: 'https://app.example', socketUrl: 'https://app.example' });
  });
  it('accepts explicit public endpoints', () => {
    expect(
      readEnvironment(
        { VITE_API_BASE_URL: 'https://api.example', VITE_SOCKET_URL: 'https://socket.example' },
        'https://app.example',
      ),
    ).toEqual({ apiBaseUrl: 'https://api.example', socketUrl: 'https://socket.example' });
  });
  it.each(['javascript:alert(1)', '******example.com', 'https://example.com?secret=1'])(
    'rejects unsafe URLs %s',
    (url) => {
      expect(() => readEnvironment({ VITE_API_BASE_URL: url }, 'https://app.example')).toThrow();
    },
  );
});
