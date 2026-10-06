import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { logger } from '@/shared/logger';

describe('ErrorBoundary', () => {
  it('renders children normally', () => {
    render(<ErrorBoundary><p>Healthy content</p></ErrorBoundary>);
    expect(screen.getByText('Healthy content')).toBeInTheDocument();
  });

  it('contains rendering failures without displaying error details', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(logger, 'error');
    const preventExpectedError = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener('error', preventExpectedError);
    function Broken(): never { throw new Error('sensitive-launch-data'); }
    render(<ErrorBoundary><Broken /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.queryByText('sensitive-launch-data')).not.toBeInTheDocument();
    expect(logSpy).toHaveBeenCalledWith('render-failed', expect.any(Error));
    window.removeEventListener('error', preventExpectedError);
    logSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
