import { useEffect, useState } from 'react';
import { api, type Row } from './api';
import { Avatar, Field, Form, Modal, Secret, useCtx } from './kit';

/** Human access: invitations are bearer secrets, never a shared account or password. */
export function People() {
  const { board, me, act } = useCtx();
  const [adding, setAdding] = useState(false);
  const [invite, setInvite] = useState<{ key: string; role: string; expires: string } | null>(null);
  const [roleOf, setRoleOf] = useState<Row | null>(null);
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
            <div className="row"><Avatar id={p.id} size={44} /><b>{p.name}</b><span className="grow" /><span className="badge">{p.role}</span></div>
            {p.about && <p className="about">{p.about}</p>}
            <p className="muted about">{p.role === 'admin' ? 'Manages people, agents and all work.' : p.role === 'member' ? 'Collaborates on tasks, messages and reviews. Cannot manage access or see unrelated private work.' : 'Read-only access to shared work. Cannot manage access or see unrelated private work.'}</p>
            {admin && <div className="row end"><button onClick={() => setRoleOf(p)}>Change role</button></div>}
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
      {admin && <Github />}
      {adding && <Invite onClose={() => setAdding(false)} onMade={(made) => { setAdding(false); setInvite(made); }} />}
      {invite && <Secret title={`Invitation · ${invite.role}`} value={`${location.origin}${location.pathname}#invite=${encodeURIComponent(invite.key)}`} onClose={() => setInvite(null)}><p className="muted">Send this link privately. The recipient chooses their own login and password. Valid until {new Date(invite.expires).toLocaleString()}.</p></Secret>}
      {roleOf && <Role user={roleOf} onClose={() => setRoleOf(null)} />}
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
function Github() {
  const { act, tick } = useCtx();
  const [status, setStatus] = useState<Row | null>(null);
  const [owner, setOwner] = useState('RayforceDB');
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
          <div className="row end"><button onClick={() => void act(async () => { await api.githubSync(); load(); })}>Check now</button></div>
        </>
      )}
    </section>
  );
}
