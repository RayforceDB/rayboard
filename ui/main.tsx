import { Component, StrictMode, useCallback, useEffect, useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { ago, api, useBoard, usd, type Row } from './api';
import { Agents } from './agents';
import { People } from './people';
import { Chat } from './chat';
import { Icon, type IconName } from './icons';
import { AgentStrip, Avatar, Badge, BoardContext, Brand, BuiltOn, Empty, Field, Form, Modal, Who, useCtx, type Ctx } from './kit';
import { Activity, Costs, Reviews } from './misc';
import { Tasks } from './tasks';
import { Profile } from './profile';
import { unreadCount, useUnread } from './unread';
import { listenToRoute, parseRoute, routeHash } from './route';
import { ResizeHandle, panelWidth } from './resize';

/** The sidebar: what there is to look at, in the order of a working day. */
const NAV: [view: string, label: string, icon: IconName][] = [
  ['overview', 'Overview', 'home'],
  ['tasks', 'Board', 'board'],
  ['reviews', 'Reviews', 'review'],
  ['chat', 'Discussions', 'chat'],
  ['agents', 'Agents', 'agents'],
  ['people', 'People', 'user'],
  ['costs', 'Costs', 'costs'],
  ['activity', 'Activity', 'activity'],
];

function App() {
  const [session, setSession] = useState<{ setup: boolean; user: Row | null; unsafe?: boolean } | null>(null);
  const load = useCallback(() => void api.session().then(setSession, () => setSession({ setup: false, user: null })), []);
  useEffect(load, [load]);
  if (session === null) return null;
  if (session.user === null) return <SignIn setup={session.setup} onDone={load} />;
  return <Shell me={session.user} onSignedOut={load} unsafe={session.unsafe === true} />;
}

function SignIn({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [joining, setJoining] = useState(() => location.hash.startsWith('#invite=') || new URLSearchParams(location.search).has('invite'));
  const [code, setCode] = useState('');
  useEffect(() => {
    if (!joining) return;
    const frame = window.location.hash.slice(1);
    if (frame.startsWith('invite=')) setCode(decodeURIComponent(frame.slice(7)));
  }, [joining]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = (): Promise<void> => (joining ? api.join(code, name, password) : setup ? api.setup(code, name, password) : api.login(name, password)).then(() => { if (joining) history.replaceState(null, '', location.pathname); onDone(); }, (e: Error) => setError(e.message));
  return (
    <main className="signin">
      <div className="card">
        <Brand />
        <p className="muted">{joining ? 'You have been invited. Choose your login and password; the invitation is single-use and is not sent in HTTP logs.' : setup ? 'Nobody oversees this board yet. Create the first account with the setup code printed on the server\'s console.' : 'Sign in to take part in the board.'}</p>
        <Form onSubmit={submit} submit={joining ? 'Accept invitation' : setup ? 'Create account' : 'Sign in'}>
          {(setup || joining) && (
            <Field label={joining ? 'Invitation' : 'Setup code'}>
              <input value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="off" spellCheck={false} />
            </Field>
          )}
          <Field label="Name" hint={setup ? '2 to 32 of a-z, 0-9, - and _' : undefined}>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!setup && !joining} required autoComplete="username" spellCheck={false} />
          </Field>
          <Field label="Password" hint={setup ? 'At least 10 characters' : undefined}>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={setup || joining ? 10 : 1} autoComplete={setup || joining ? 'new-password' : 'current-password'} />
          </Field>
          {error && <p className="error" role="alert">{error}</p>}
        </Form>
        {!setup && <p className="muted"><button className="link" onClick={() => { setJoining(!joining); setCode(''); setError(''); }}>{joining ? 'Already have an account? Sign in' : 'Have an invitation?'}</button></p>}
        <BuiltOn />
      </div>
    </main>
  );
}

function Shell({ me, onSignedOut, unsafe }: { me: Row; onSignedOut: () => void; unsafe: boolean }) {
  const { board, tick, live, failed } = useBoard(onSignedOut);
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => listenToRoute(window, setRoute), []);
  const [error, setError] = useState('');
  const [changing, setChanging] = useState(false);
  const unread = useUnread(me.id);
  const [profile, setProfile] = useState(false);
  const [sidebar, setSidebar] = useState(() => panelWidth('sidebar', 236, 180, 360));
  const open = useCallback((view: string, item = '') => {
    const hash = routeHash({ view, item });
    if (location.hash !== hash) history.pushState(null, '', hash);
    setRoute(parseRoute(hash));
  }, []);
  const act = useCallback(async (work: () => Promise<unknown>) => {
    try {
      await work();
      setError('');
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, []);
  useEffect(() => {
    if (error === '') return;
    const t = setTimeout(() => setError(''), 8000);
    return () => clearTimeout(t);
  }, [error]);

  const readOnly = me.role === 'viewer';
  const current = board?.people.find((p) => p.id === me.id) ?? me;
  const ctx = useMemo((): Ctx | null => {
    if (board === null) return null;
    const names = new Map([...board.agents, ...board.people].map((a) => [a.id as string, a.name as string]));
    return { board, tick, me: current, unread: unread.unread, markRead: unread.markRead, name: (id) => names.get(id) ?? id, act, open };
  }, [board, tick, current, act, open]);
  const shownCtx = useMemo((): Ctx | null => ctx === null ? null : readOnly ? { ...ctx, act: async () => { setError('Viewers have read-only access'); return false; } } : ctx, [ctx, readOnly]);
  if (ctx === null || board === null) return failed ? <Broken what="The board could not be loaded" detail={failed} /> : null;

  const waiting = board.agents.filter((a) => a.status === 'pending').length;
  const counts: Record<string, number> = { reviews: board.reviews.length, agents: waiting, tasks: unreadCount(board.tasks,unread.reads,me.id), chat: unreadCount([...board.channels,...board.dms],unread.reads,me.id) };
  return (
    <BoardContext.Provider value={shownCtx}>
      <div className="shell" style={{ gridTemplateColumns: `${sidebar}px minmax(0, 1fr)`, '--sidebar-width': `${sidebar}px` } as CSSProperties}>
        <nav>
          <Brand />
          <div className="section">
            {NAV.map(([view, label, icon]) => (
              <button key={view} className={route.view === view ? 'on' : ''} onClick={() => open(view)}>
                <Icon name={icon} size={18} />
                {label}
                {counts[view] ? <span className="count">{counts[view]}</span> : null}
              </button>
            ))}
          </div>
          <div className="section roster">
            <h3>Agents</h3>
            {board.agents.filter((a) => a.status !== 'revoked').map((a) => (
              <button key={a.id} onClick={() => open('chat', `dm:${[me.id, a.id].sort().join(':')}`)} title={a.about || a.kind}>
                <Avatar id={a.id} size={18} />
                <span className="grow">{a.name}</span>
                {a.status !== 'active' ? <span className="state">{a.status}</span> : <i className={`dot ${a.online ? 'on' : ''}`} title={a.online ? 'online' : 'offline'} />}
              </button>
            ))}
          </div>
          <div className="grow" />
          <BuiltOn />
          <div className="me">
            <Avatar id={current.id} size={26} />
            {unsafe ? <span className="grow name">{me.name}</span> : <button className="ghost grow name" onClick={() => setProfile(true)} title="Your profile">{current.name}</button>}
            <span className={`live ${live ? 'on' : ''}`} title={live ? 'live' : 'reconnecting'} />
            {unsafe ? <span className="unsafe" title="Nobody signs in: whoever reaches this port oversees the board">unsafe</span> : <button className="ghost icon" onClick={() => void api.logout().then(onSignedOut)} aria-label="Sign out" title="Sign out"><Icon name="out" /></button>}
          </div>
        </nav>
        <ResizeHandle name="sidebar" value={sidebar} setValue={setSidebar} min={180} max={360} />
        <main>
          {route.view === 'overview' && <Overview />}
          {route.view === 'tasks' && <Tasks item={route.item} />}
          {route.view === 'reviews' && <Reviews />}
          {route.view === 'chat' && <Chat item={route.item} />}
          {route.view === 'agents' && <Agents />}
          {route.view === 'people' && <People />}
          {route.view === 'costs' && <Costs />}
          {route.view === 'activity' && <Activity />}
        </main>
        {profile && <Profile onClose={() => setProfile(false)} onPassword={() => { setProfile(false); setChanging(true); }} />}
        {changing && <Password onClose={() => setChanging(false)} onDone={onSignedOut} />}
        {error && <div className="toast" role="alert" onClick={() => setError('')}>{error}</div>}
      </div>
    </BoardContext.Provider>
  );
}

function Password({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  return (
    <Modal title="Change password" onClose={onClose}>
      <Form submit="Change and sign out everywhere" onSubmit={() => api.password(current, next).then(onDone, (e: Error) => setError(e.message))}>
        <Field label="Current password"><input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus autoComplete="current-password" /></Field>
        <Field label="New password" hint="At least 10 characters. Every session of yours ends, this one too."><input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} autoComplete="new-password" /></Field>
        {error && <p className="error" role="alert">{error}</p>}
      </Form>
    </Modal>
  );
}

function Overview() {
  const { board, open, tick } = useCtx();
  const [events, setEvents] = useState<Row[]>([]);
  useEffect(() => void api.call<Row[]>('activity', { limit: 14 }).then(setEvents, () => {}), [tick]);
  const count = (status: string): number => board.tasks.filter((t) => t.status === status).length;
  const active = board.agents.filter((a) => a.status !== 'revoked');
  const pending = board.agents.filter((a) => a.status === 'pending');
  const paused = board.agents.filter((a) => a.status === 'paused');
  const spent = board.agents.reduce((sum, a) => sum + (a.spent as number), 0);
  const stale = board.tasks.filter((t) => t.status === 'open' && t.assignee === '');
  const held = board.tasks.filter((t) => t.status === 'waiting' || t.status === 'blocked');
  return (
    <>
      <header className="title-bar"><div className="grow"><h1>Overview</h1><p className="muted">What the agents are doing, and what waits on you.</p></div></header>
      <AgentStrip />
      <section className="tiles">
        <button className="tile" onClick={() => open('agents')}><b>{active.filter((a) => a.online).length}<small> / {active.length}</small></b><span>agents online</span></button>
        <button className="tile" onClick={() => open('tasks')}><b>{count('in_progress')}</b><span>tasks in progress</span></button>
        <button className="tile" onClick={() => open('tasks')}><b>{stale.length}</b><span>open and unclaimed</span></button>
        <button className="tile" onClick={() => open('tasks')}><b>{held.length}</b><span>waiting or blocked</span></button>
        <button className="tile" onClick={() => open('reviews')}><b>{board.reviews.length}</b><span>reviews waiting</span></button>
        <button className="tile" onClick={() => open('costs')}><b>{usd(spent)}</b><span>spent this month</span></button>
      </section>
      <div className="columns">
        <section className="panel">
          <h3>Needs you</h3>
          {pending.length + paused.length + board.reviews.length === 0 && <Empty>Nothing is waiting for a person.</Empty>}
          <ul className="list">
            {pending.map((a) => (
              <li key={a.id} onClick={() => open('agents')}><Badge status="pending" /><span className="grow"><b>{a.name}</b> asked to join</span><time>{ago(a.created, Date.parse(board.now))}</time></li>
            ))}
            {paused.map((a) => (
              <li key={a.id} onClick={() => open('agents')}><Badge status="paused" /><span className="grow"><b>{a.name}</b>: {a.reason}</span></li>
            ))}
            {board.reviews.map((r) => (
              <li key={r.id} onClick={() => open('tasks', r.task)}><Badge status="in_review" /><span className="grow"><code>{r.task}</code> by <Who id={r.requester} />{r.reviewer ? <> for <Who id={r.reviewer} /></> : ' (open to anyone)'}</span><time>{ago(r.created, Date.parse(board.now))}</time></li>
            ))}
          </ul>
        </section>
        <section className="panel">
          <h3>Latest</h3>
          {events.length === 0 && <Empty>Nothing has happened yet. Add an agent to begin.</Empty>}
          <ul className="list feed">
            {events.map((e) => (
              <li key={e.seq} onClick={() => (/^T-/.test(e.subject) ? open('tasks', e.subject) : undefined)}><span className="grow">{e.summary}</span><time>{ago(e.ts, Date.parse(board.now))}</time></li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

/** What is shown instead of an empty page when something went wrong, with a way on. */
function Broken({ what, detail }: { what: string; detail: string }) {
  return (
    <main className="signin">
      <div className="card">
        <Brand />
        <p className="error" role="alert">{what}.</p>
        <pre className="prose muted">{detail}</pre>
        <p className="muted">If the server was updated while this page was open, reloading it is enough.</p>
        <div className="row end"><button className="primary" onClick={() => location.reload()}>Reload</button></div>
      </div>
    </main>
  );
}

/** A fault while drawing the page ends here, with what it was, instead of in a blank page. */
class Guard extends Component<{ children: ReactNode }, { fault: string }> {
  state = { fault: '' };
  static getDerivedStateFromError(err: unknown): { fault: string } {
    return { fault: err instanceof Error ? err.message : String(err) };
  }
  render(): ReactNode {
    return this.state.fault ? <Broken what="The dashboard failed to draw this page" detail={this.state.fault} /> : this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode><Guard><App /></Guard></StrictMode>);
