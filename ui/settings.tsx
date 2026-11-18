import { Github } from './people';
import { useCtx } from './kit';

/** What an administrator sets up for the whole board, apart from who is on it: the integrations. */
export function Settings() {
  const { me } = useCtx();
  return (
    <>
      <header className="head">
        <div><h2>Settings</h2><p className="muted">Integrations of the board. Only administrators see this.</p></div>
      </header>
      {me.role === 'admin' ? <Github /> : <p className="muted">Only an administrator can change the board's settings.</p>}
    </>
  );
}
