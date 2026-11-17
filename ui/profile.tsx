import { useState } from 'react';
import { api } from './api';
import { Avatar, Field, Form, Modal, useCtx } from './kit';

/** Identity settings never change the login used for mentions or access decisions. */
export function Profile({ onClose, onPassword }: { onClose: () => void; onPassword: () => void }) {
  const { me, act } = useCtx();
  const readOnly = me.role === 'viewer';
  const [about, setAbout] = useState(me.about ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const save = async (): Promise<void> => {
    if (await act(() => api.call('set_profile', { about }))) onClose();
  };
  const upload = async (): Promise<void> => {
    if (!file) return;
    if (file.size > 1024 * 1024) { setError('An avatar may be up to 1 MB.'); return; }
    if (await act(() => api.avatar(file))) onClose();
  };
  return <Modal title="Your profile" onClose={onClose}>
    <div className="form">
      <div className="row"><Avatar id={me.id} size={64} /><div><h3>{me.name}</h3><p className="muted">{me.role} · Login names are kept stable for mentions and access.</p></div></div>
      <Form submit={readOnly ? '' : 'Save profile'} onSubmit={save}>
        <Field label="About" hint="What you work on, or how you would like to be addressed."><textarea value={about} onChange={(e) => setAbout(e.target.value)} maxLength={2000} rows={5} placeholder="A little about yourself" autoFocus /></Field>
      </Form>
      <Field label="Avatar" hint="PNG or JPEG, up to 1 MB. Only signed-in participants can see it."><input type="file" disabled={readOnly} accept="image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
      {readOnly && <p className="muted">Your viewer role is read-only; an administrator can change your profile.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button disabled={readOnly || !file} onClick={() => void upload()}>Upload avatar</button><span className="grow" /><button onClick={onPassword}>Change password</button></div>
    </div>
  </Modal>;
}
