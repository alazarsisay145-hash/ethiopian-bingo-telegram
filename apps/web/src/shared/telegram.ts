import { init, initData, isTMA } from '@telegram-apps/sdk-react';
import { logger } from './logger';

export interface TelegramSession {
  initData: string;
}

let initialized = false;

export async function initializeTelegram(): Promise<TelegramSession | null> {
  try {
    // Launch parameters can be cached outside Telegram; require a live bridge.
    if (!(await isTMA('complete', { timeout: 1500 }))) return null;
    if (!initialized) {
      init();
      initialized = true;
    }
    initData.restore();
    const raw = initData.raw();
    const user = initData.user();
    if (!raw || !user || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
    return { initData: raw };
  } catch (error) {
    logger.error('telegram-unavailable', error);
    return null;
  }
}
