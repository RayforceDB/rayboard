import { useEffect, useState } from 'react';
import { api, type Row } from './api';
import { Avatar, Field, Form, Modal, Secret, personState, useCtx } from './kit';

/** Human access: invitations are bearer secrets, never a shared account or password. */
export function People() {
  const { board, me, act } = useCtx();
  const [adding, setAdding] = useState(false);
  const [invite, setInvite] = useState<{ key: string; role: string; expires: string } | null>(null);
  const [roleOf, setRoleOf] = useState<Row | null>(null);
  const [leaving, setLeaving] = useState<Row | null>(null);
  const admin = me.role === 'admin';
  return (
    <>
      <header className="head">
        <div><h2>People</h2><p className="muted">Colleagues collaborate here with their own account and access.</p></div>
        <div className="grow" />
        {admin && <button className="primary" onClick={() => setAdding(true)}>Invite person</button>}
      </header>
      <div className="cards">
        {board.people.filter((p) => p.status === 'active').map((p) => (
          <article key={p.id} className="agent">
            <div className="row"><Avatar id={p.id} size={44} /><span className="who-state"><b>{p.name}</b><span className={`state ${personState(board, p).tone}`} title={personState(board, p).title}><i />{personState(board, p).label}</span></span><span className="grow" /><span className="badge">{p.role}</span></div>
            {p.about && <p className="about">{p.about}</p>}
            <p className="muted about">{p.role === 'admin' ? 'Manages people, agents and all work.' : p.role === 'member' ? 'Collaborates on tasks, messages and reviews. Cannot manage access or see unrelated private work.' : 'Read-only access to shared work. Cannot manage access or see unrelated private work.'}</p>
            {admin && <div className="row end">{p.id !== me.id && <button className="danger" onClick={() => setLeaving(p)}>Deactivate</button>}<button onClick={() => setRoleOf(p)}>Change role</button></div>}
          </article>
        ))}
      </div>
      {admin && (board.invites?.length ?? 0) > 0 && (
        <section className="panel">
          <h3>Pending invitations</h3>
          <p className="muted">Single-use links expire after 48 hours. Revoke one to stop it before it is used.</p>
          {board.invites!.map((i) => <div className="row" key={i.id}><code>{i.role}</code><span className="muted">until {new Date(i.expires).toLocaleString()}</span><span className="grow" /><button onClick={() => void act(() => api.call('revoke_invite', { invite: i.id }))}>Revoke</button></div>)}
        </section>
      )}
      {adding && <Invite onClose={() => setAdding(false)} onMade={(made) => { setAdding(false); setInvite(made); }} />}
      {invite && <Secret title={`Invitation · ${invite.role}`} value={`${location.origin}${location.pathname}#invite=${encodeURIComponent(invite.key)}`} onClose={() => setInvite(null)}><p className="muted">Send this link privately. The recipient chooses their own login and password. Valid until {new Date(invite.expires).toLocaleString()}.</p></Secret>}
      {roleOf && <Role user={roleOf} onClose={() => setRoleOf(null)} />}
      {leaving && <Deactivate user={leaving} onClose={() => setLeaving(null)} />}
      {admin && board.people.some((p) => p.status !== 'active') && (
        <section className="panel">
          <h3>Deactivated</h3>
          <p className="muted">They cannot sign in. Their tasks, messages and history stay; their names are not reused.</p>
          <p className="deactivated">{board.people.filter((p) => p.status !== 'active').map((p) => <span key={p.id as string} className="who none">{p.name as string}</span>)}</p>
        </section>
      )}
    </>
  );
}

function Invite({ onClose, onMade }: { onClose: () => void; onMade: (made: { key: string; role: string; expires: string }) => void }) {
  const { act } = useCtx();
  const [role, setRole] = useState('member');
  return <Modal title="Invite person" onClose={onClose}><Form submit="Create invitation" onSubmit={() => act(async () => onMade(await api.call('invite_person', { role })))}><Field label="Access" hint="Member is the safe default. Admins see all private work and manage access; viewers only read."><select value={role} onChange={(e) => setRole(e.target.value)} autoFocus><option value="member">Member — collaborate</option><option value="viewer">Viewer — read only</option><option value="admin">Admin — full access</option></select></Field></Form></Modal>;
}

function Role({ user, onClose }: { user: Row; onClose: () => void }) {
  const { act } = useCtx();
  const [role, setRole] = useState(user.role);
  return <Modal title={`Access for ${user.name}`} onClose={onClose}><Form submit="Change role" onSubmit={async () => { if (await act(() => api.call('set_role', { user: user.id, role }))) onClose(); }}><Field label="Role" hint="A change applies to existing sessions immediately. The last administrator cannot be demoted."><select value={role} onChange={(e) => setRole(e.target.value)} autoFocus><option value="member">Member</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></Field></Form></Modal>;
}

/**
 * GitHub (T-19): the App the board reads through, and the repositories it follows. Those are chosen in one
 * place, the App's installation on GitHub; here they are only shown.
 */
export function Github() {
  const { act, tick } = useCtx();
  const [status, setStatus] = useState<Row | null>(null);
  const [owner, setOwner] = useState('RayforceDB');
  const [plan, setPlan] = useState<Row | null>(null);
  const load = (): void => void api.call('github_status').then(setStatus, () => setStatus(null));
  useEffect(load, [tick]);
  if (status === null) return null;
  const connected = status.connected as Row | null;
  const problems = ((status.app as Row | null)?.problems as string[] | undefined) ?? [];
  const followed = (status.repos as Row[]).map((r) => r.name as string);
  // GitHub creates the App from a manifest posted by the browser itself; the board then keeps its key and secret.
  const connect = (): Promise<boolean> => act(async () => {
    const started = await api.githubConnect(owner);
    const form = document.createElement('form');
    form.method = 'post';
    form.action = started.url;
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = 'manifest';
    field.value = JSON.stringify(started.manifest);
    form.appendChild(field);
    document.body.appendChild(form);
    form.submit();
  });
  return (
    <section className="panel">
      <h3>GitHub</h3>
      <p className="muted">Issues and pull requests of the repositories the App is installed on come in as tasks, one project per repository. Nothing is written to GitHub; conversations with people stay there.</p>
      {connected === null ? (
        <div className="row"><Field label="Organisation"><input value={owner} onChange={(e) => setOwner(e.target.value)} spellCheck={false} /></Field><span className="grow" /><button className="primary" onClick={() => void connect()}>Connect GitHub</button></div>
      ) : (
        <>
          <p>Connected as <a href={connected.html_url as string} target="_blank" rel="noreferrer noopener">{connected.slug as string}</a> in {connected.owner as string}.</p>
          <div className="gh-followed">
            <div className="row"><b>Followed repositories</b><span className="grow" /><a className="button small" href={`${connected.html_url as string}/installations/new`} target="_blank" rel="noreferrer noopener">Choose on GitHub</a></div>
            {followed.length === 0 ? <p className="muted">None yet. Choose them on GitHub, then Check now.</p> : <ul className="list plain">{followed.map((name) => <li key={name}><code>{name}</code></li>)}</ul>}
            <p className="muted small-print">To follow another repository, add it to the App's installation on GitHub; to stop, take it out there. The board picks the change up within ten minutes, or at once with Check now.</p>
          </div>
          {problems.length > 0 ? <ul className="error">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : status.app ? <p className="muted">Permissions and repositories checked {new Date((status.app as Row).checked as string).toLocaleString()}.</p> : <p className="muted">Not checked yet.</p>}
          <div className="row end"><button onClick={() => void act(async () => { setPlan(await api.call('reconcile_github', { dry_run: true }) as Row); })}>Close finished imports…</button><button onClick={() => void act(async () => { await api.githubSync(); load(); })}>Check now</button></div>
        </>
      )}
      {plan !== null ? <Reconcile plan={plan} onClose={() => setPlan(null)} /> : null}
    </section>
  );
}

/**
 * T-479: tasks from GitHub left open although their item was merged or closed there, and nobody took them up.
 * A dry run shows what would close; closing them is a second, deliberate step.
 */
function Reconcile({ plan, onClose }: { plan: Row; onClose: () => void }) {
  const { act } = useCtx();
  const done = plan.done as number;
  const cancelled = plan.cancelled as number;
  const skipped = plan.skipped as Row[];
  if (done + cancelled === 0) {
    return <Modal title="Close finished imports" onClose={onClose}><p>Nothing to close: every task whose GitHub item is merged or closed is already closed here, or someone took it up.</p>{skipped.length > 0 ? <p className="muted">{skipped.length} left to whoever took them up: {skipped.map((s) => s.task as string).join(' ')}</p> : null}</Modal>;
  }
  return (
    <Modal title="Close finished imports" onClose={onClose}>
      <Form submit={`Close ${done + cancelled} tasks`} onSubmit={async () => { if (await act(() => api.call('reconcile_github', {}))) onClose(); }}>
        <p>{done} will be done (merged, or issue closed) and {cancelled} cancelled (pull request closed without merging). Each says why and links its GitHub item. Nothing is written to GitHub.</p>
        {skipped.length > 0 ? <p className="muted">Left alone, because someone took them up: {skipped.map((s) => `${s.task as string} (${s.why as string})`).join(', ')}</p> : null}
      </Form>
    </Modal>
  );
}

function Deactivate({ user, onClose }: { user: Row; onClose: () => void }) {
  const { act } = useCtx();
  return (
    <Modal title={`Deactivate ${user.name}?`} onClose={onClose}>
      <Form submit={`Deactivate ${user.name}`} danger onSubmit={async () => { if (await act(() => api.call('deactivate_person', { user: user.id }))) onClose(); }}>
        <p>{user.name as string} is signed out everywhere at once and can no longer sign in. Their tasks, messages and history stay as they are, and the name is not given to anyone else.</p>
        <p className="muted">This cannot be undone from the dashboard. The last administrator cannot be deactivated, and nobody can deactivate themselves.</p>
      </Form>
    </Modal>
  );
}
