import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createApi } from '@/shared/api';
import { readEnvironment } from '@/shared/environment';
import { createBingoSocket, type BingoSocket } from '@/shared/socket';
import { createSessionStore, type SessionStore } from '@/shared/store';
import { initializeTelegram, type TelegramSession } from '@/shared/telegram';

interface AppServices {
  api: ReturnType<typeof createApi>;
  session: SessionStore;
  socket: BingoSocket;
}

const ServicesContext = createContext<AppServices | null>(null);

export function TelegramGate({ children }: { children: (session: TelegramSession) => ReactNode }) {
  const [telegram, setTelegram] = useState<TelegramSession | null | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void initializeTelegram().then((session) => { if (active) setTelegram(session); });
    return () => { active = false; };
  }, []);
  if (telegram === undefined) return <main><p role="status">Checking Telegram environment…</p></main>;
  if (!telegram) return <main><h1>Open this app inside Telegram</h1><p>Use the bot’s Mini App button to continue.</p></main>;
  return <>{children(telegram)}</>;
}

export function AppProviders({ telegram, children }: { telegram: TelegramSession; children: ReactNode }) {
  const [services] = useState<AppServices>(() => {
    const environment = readEnvironment(import.meta.env, window.location.origin);
    const session = createSessionStore();
    return {
      session,
      api: createApi(environment.apiBaseUrl, () => telegram.initData),
      socket: createBingoSocket(environment.socketUrl, telegram.initData, session),
    };
  });
  useEffect(() => {
    services.socket.connect();
    return () => { services.socket.disconnect(); };
  }, [services]);
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('App providers are required');
  return services;
}

export function useSessionState() {
  return useStore(useServices().session.store);
}
