import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  isTMA: vi.fn<() => Promise<boolean>>(),
  restore: vi.fn(),
  raw: vi.fn<() => string | undefined>(),
  user: vi.fn<() => { id: number } | undefined>(),
}));
vi.mock('@telegram-apps/sdk-react', () => ({
  init: sdk.init,
  isTMA: sdk.isTMA,
  initData: { restore: sdk.restore, raw: sdk.raw, user: sdk.user },
}));

import { TelegramGate } from '@/app/providers';
import { initializeTelegram } from './telegram';

describe('Telegram environment gate', () => {
  beforeEach(() => {
    sdk.restore.mockReset();
    sdk.isTMA.mockResolvedValue(true);
    sdk.raw.mockReturnValue(undefined);
    sdk.user.mockReturnValue(undefined);
  });

  it('blocks a browser with no real launch data', async () => {
    const child = vi.fn(() => <p>Authenticated content</p>);
    render(<TelegramGate>{child}</TelegramGate>);
    expect(await screen.findByText('Open this app inside Telegram')).toBeInTheDocument();
    expect(child).not.toHaveBeenCalled();
    expect(sdk.init).toHaveBeenCalled();
  });

  it('does not fabricate a user when launch data has no user', async () => {
    sdk.raw.mockReturnValue('query_id=example');
    await expect(initializeTelegram()).resolves.toBeNull();
  });

  it('fails closed if SDK restoration fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sdk.restore.mockImplementation(() => { throw new Error('unsupported context'); });
    await expect(initializeTelegram()).resolves.toBeNull();
    consoleSpy.mockRestore();
  });

  it('passes actual launch data without manufacturing profile data', async () => {
    sdk.raw.mockReturnValue('verified-by-server-not-client');
    sdk.user.mockReturnValue({ id: 123 });
    render(<TelegramGate>{(session) => <p>{session.initData}</p>}</TelegramGate>);
    expect(await screen.findByText('verified-by-server-not-client')).toBeInTheDocument();
    expect(sdk.isTMA).toHaveBeenCalledWith('complete', { timeout: 1500 });
  });

  it('rejects an invalid Telegram user id', async () => {
    sdk.raw.mockReturnValue('raw');
    sdk.user.mockReturnValue({ id: -1 });
    await expect(initializeTelegram()).resolves.toBeNull();
  });

  it('rejects cached launch data without a live Telegram bridge', async () => {
    sdk.isTMA.mockResolvedValue(false);
    sdk.raw.mockReturnValue('cached-launch-data');
    sdk.user.mockReturnValue({ id: 123 });
    const child = vi.fn(() => <p>Private content</p>);
    render(<TelegramGate>{child}</TelegramGate>);
    expect(await screen.findByText('Open this app inside Telegram')).toBeInTheDocument();
    expect(child).not.toHaveBeenCalled();
  });
});
