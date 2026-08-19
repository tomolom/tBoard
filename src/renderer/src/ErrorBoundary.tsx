import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Catches render/effect errors anywhere below it and shows a readable message
 * instead of React unmounting to a blank white screen. Without this, a single
 * throw (e.g. a missing preload API) leaves no on-screen indication of what
 * went wrong.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Also log to the console so it reaches the main-process forwarder / DevTools.
    console.error('tBoard renderer error:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <div className="fatal">
          <h1>Something went wrong</h1>
          <p>The interface hit an unexpected error and stopped rendering.</p>
          <pre className="fatal-detail">{error.message}</pre>
          <button type="button" className="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
