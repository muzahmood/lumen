import { Component, type ErrorInfo, type ReactNode } from 'react';
import { CircleAlert, CloudOff, RefreshCw } from 'lucide-react';
import { diagnoseLoadFailure, isChunkError, reloadForNewVersion, type LoadFailure } from '../lib/recovery';
import { Spinner } from './ui';

type Cause = LoadFailure | 'other' | 'checking';

interface Props {
  children: ReactNode;
  /**
   * 'app' replaces the whole screen; 'pane' fills just the note area so the sidebar and list keep
   * working; 'dialog' renders nothing and reports through onFail, so the dialog can close itself.
   */
  scope: 'app' | 'pane' | 'dialog';
  /** What failed, for messages: "Settings", "The drawing editor". */
  label?: string;
  /** Changing this clears the error (e.g. opening a different note). */
  resetKey?: unknown;
  /** Called before "Try again" clears the error, e.g. to let a failed download be retried. */
  onReset?: () => void;
  /** scope 'dialog': called once the cause is known, with a message to show the person. */
  onFail?: (message: string, cause: Exclude<Cause, 'checking'>) => void;
}

interface State {
  error: Error | null;
  cause: Cause;
}

/** Shows a way out instead of a blank page when something fails to render or download. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, cause: 'other' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, cause: isChunkError(error) ? 'checking' : 'other' };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Lumen hit an error while rendering', error, info.componentStack);
    if (!isChunkError(error)) {
      this.settle('other');
      return;
    }
    void diagnoseLoadFailure().then((cause) => {
      if (this.state.error !== error) return;
      this.settle(cause);
      // A note pane or the app shell holds nothing unsaved (note edits are kept on the device), so
      // go straight to the new version. A dialog asks first instead: see App's onFail handlers.
      if (cause === 'updated' && this.props.scope !== 'dialog') reloadForNewVersion();
    });
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.retry();
  }

  private settle(cause: Exclude<Cause, 'checking'>) {
    this.setState({ cause });
    if (this.props.scope === 'dialog') this.props.onFail?.(this.dialogMessage(cause), cause);
  }

  private dialogMessage(cause: Exclude<Cause, 'checking'>) {
    const what = this.props.label ?? 'That';
    if (cause === 'updated') return `Lumen has been updated. Reload to open ${what.toLowerCase()}.`;
    if (cause === 'offline') return `${what} isn’t saved on this device yet. It opens once you’re back online.`;
    return `${what} couldn’t open. Reloading usually fixes it; your edits are kept on this device.`;
  }

  private retry = () => {
    this.props.onReset?.();
    this.setState({ error: null, cause: 'other' });
  };

  render() {
    const { error, cause } = this.state;
    if (!error) return this.props.children;
    const { scope } = this.props;
    if (scope === 'dialog') return null;

    if (cause === 'checking') {
      return scope === 'app' ? (
        <main className="splash" aria-busy="true">
          <Spinner label="Loading" />
        </main>
      ) : (
        <section className="note-pane" aria-busy="true">
          <div className="note-message">
            <Spinner label="Loading" />
          </div>
        </section>
      );
    }

    const what = this.props.label ?? 'This part of Lumen';
    const copy =
      cause === 'updated'
        ? { title: 'Lumen has been updated', message: 'Reload to get the new version. Your edits are kept on this device.' }
        : cause === 'offline'
          ? { title: 'You’re offline', message: `${what} isn’t saved on this device yet, so it opens once you’re back online.` }
          : {
              title: scope === 'app' ? 'Something went wrong' : 'This note couldn’t be shown',
              message: 'Reloading usually fixes it. Your edits are kept on this device and sync after the reload.',
            };
    const icon = cause === 'offline' ? <CloudOff size={scope === 'app' ? 30 : 22} /> : <CircleAlert size={scope === 'app' ? 30 : 22} className="error-icon" />;
    const actions = (
      <div className="error-actions">
        {cause !== 'updated' && (
          <button type="button" className={cause === 'offline' ? 'btn btn-primary' : 'btn'} onClick={this.retry}>
            Try again
          </button>
        )}
        {cause !== 'offline' && (
          <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
            <RefreshCw size={15} /> Reload
          </button>
        )}
      </div>
    );

    if (scope === 'app') {
      return (
        <main className="splash" role="alert">
          {icon}
          <h1>{copy.title}</h1>
          <p>{copy.message}</p>
          {actions}
        </main>
      );
    }
    return (
      <section className="note-pane" role="alert">
        <div className="note-message">
          {icon}
          <p>
            <strong>{copy.title}</strong>
            <br />
            {copy.message}
          </p>
          {actions}
        </div>
      </section>
    );
  }
}
