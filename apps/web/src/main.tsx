import { createRoot } from 'react-dom/client';
import { AppProviders, TelegramGate } from './app/providers';
import { AppRouter } from './app/router';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');

createRoot(root).render(
  <ErrorBoundary>
    <TelegramGate>
      {(telegram) => <AppProviders telegram={telegram}><AppRouter /></AppProviders>}
    </TelegramGate>
  </ErrorBoundary>,
);
