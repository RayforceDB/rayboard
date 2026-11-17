import { useState } from 'react';
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
        {board.people.map((p) => (
          <article key={p.id} className="agent">
            <div className="row"><Avatar id={p.id} size={30} /><b>{p.name}</b><span className="grow" /><span className="badge">{p.role}</span></div>
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
