import { useEffect, useState } from 'react';
import { useSessionState } from './providers';

type Route = 'lobby' | 'game' | 'profile';

function currentRoute(): Route {
  const hash = window.location.hash.slice(1);
  return hash === '/game' ? 'game' : hash === '/profile' ? 'profile' : 'lobby';
}

export function AppRouter() {
  const [route, setRoute] = useState(currentRoute);
  const state = useSessionState();
  useEffect(() => {
    const navigate = () => setRoute(currentRoute());
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  return (
    <main>
      <h1>Ethiopian Bingo</h1>
      <nav aria-label="Main navigation">
        <a href="#/lobby" aria-current={route === 'lobby' ? 'page' : undefined}>
          Lobby
        </a>
        <a href="#/game" aria-current={route === 'game' ? 'page' : undefined}>
          Game
        </a>
        <a href="#/profile" aria-current={route === 'profile' ? 'page' : undefined}>
          Profile
        </a>
      </nav>
      {Object.values(state.syncing).some(Boolean) && <p role="status">Syncing with the server…</p>}
      {state.serverError && <p role="alert">The server could not complete the request.</p>}
      <section aria-labelledby="screen-heading">
        <h2 id="screen-heading">
          {route === 'lobby' ? 'Lobby' : route === 'game' ? 'Game' : 'Profile'}
        </h2>
        {route === 'lobby' && <p>Room selection will be available in the next phase.</p>}
        {route === 'game' && (
          <p>
            {state.game ? 'Game state received from the server.' : 'Waiting for server game state.'}
          </p>
        )}
        {route === 'profile' && (
          <p>Profile and wallet screens will be available in the next phase.</p>
        )}
      </section>
    </main>
  );
}
