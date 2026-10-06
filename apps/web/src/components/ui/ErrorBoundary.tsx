import { Component, type ReactNode } from 'react';
import { logger } from '@/shared/logger';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    logger.error('render-failed', error);
  }

  override render(): ReactNode {
    return this.state.failed
      ? <main role="alert"><h1>Something went wrong</h1><p>Please close and reopen the app.</p></main>
      : this.props.children;
  }
}
