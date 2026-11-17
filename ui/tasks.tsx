import { useEffect, useState } from 'react';
import { ago, api, clock, usd, type Row } from './api';
import { Badge, Empty, Field, Form, Modal, STATUS_LABEL, Who, useCtx } from './kit';
import { Prose } from './prose';

const COLUMNS = ['open', 'in_progress', 'waiting', 'in_review', 'changes_requested', 'done'] as const;
const PRIORITY = ['Low', 'Normal', 'High', 'Urgent'];

export function Tasks({ item }: { item: string }) {
  const { board, open } = useCtx();
  const [creating, setCreating] = useState(false);
  const [layout, setLayout] = useState<'list' | 'board'>('list');
  const [showAll, setShowAll] = useState(false);
  if (item) return <TaskDetail id={item} onClose={() => open('tasks')} />;
  const cancelled = board.tasks.filter((t) => t.status === 'cancelled').length;
  const now = Date.parse(board.now);
  // Waiting and blocked share a group: both are work that stands still, and each row says which.
  const groups = [...COLUMNS, ...(showAll ? (['cancelled'] as const) : [])].map((status) => {
    const tasks = board.tasks.filter((t) => t.status === status || (status === 'waiting' && t.status === 'blocked'));
    return { status, tasks: status === 'done' || status === 'cancelled' ? tasks.slice(0, 30) : tasks.sort((x, y) => y.priority - x.priority || y.seq - x.seq), total: tasks.length };
  });
  return (
    <>
      <header className="head">
        <h2>Tasks</h2>
        <div className="grow" />
        {cancelled > 0 && <label className="check"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> {cancelled} cancelled</label>}
        <div className="seg" role="group" aria-label="Layout">
          <button className={layout === 'list' ? 'on' : ''} onClick={() => setLayout('list')}>List</button>
          <button className={layout === 'board' ? 'on' : ''} onClick={() => setLayout('board')}>Board</button>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>New task</button>
      </header>
      {board.tasks.length === 0 && <Empty>No tasks yet. Create one, or let an agent do it with <code>create_task</code>.</Empty>}
      {layout === 'list' && board.tasks.length > 0 && (
        <div className="groups">
          {groups.filter((g) => g.total > 0).map((g) => (
            <section key={g.status}>
              <h3>{g.status === 'waiting' ? 'Waiting / blocked' : STATUS_LABEL[g.status]} <span>{g.total}</span></h3>
              {g.tasks.map((t) => (
                <button key={t.id} className="task-row" onClick={() => open('tasks', t.id)}>
                  <i className={`ring s-${t.status}`} />
                  <code>{t.id}</code>
                  <span className="title">{t.title}</span>
                  {t.dependency && <span className="muted dep">{t.status} on {t.dependency}</span>}
                  <span className="grow" />
                  {t.private === 1 && <span className="lock">private</span>}
                  {t.priority >= 2 && <span className={`prio p${t.priority}`}>{PRIORITY[t.priority]?.toLowerCase()}</span>}
                  {t.parent && <span className="muted">in {t.parent}</span>}
                  <Who id={t.assignee} empty="unclaimed" />
                  <time>{ago(t.updated, now)}</time>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
      {layout === 'board' && board.tasks.length > 0 && (
        <div className="kanban">
          {groups.map((g) => (
            <section key={g.status} className="lane">
              <h3>{g.status === 'waiting' ? 'Waiting / blocked' : STATUS_LABEL[g.status]} <span>{g.total}</span></h3>
              {g.tasks.map((t) => (
                <button key={t.id} className="card-task" onClick={() => open('tasks', t.id)}>
                  <span className="row"><i className={`ring s-${t.status}`} /><code>{t.id}</code><span className="grow" />{t.priority >= 2 && <span className={`prio p${t.priority}`}>{PRIORITY[t.priority]?.toLowerCase()}</span>}</span>
                  <b>{t.title}</b>
                  {t.dependency && <span className="dep">{t.status} on {t.dependency}</span>}
                  <span className="row">{t.private === 1 && <span className="lock">private</span>}<Who id={t.assignee} empty="unclaimed" /><span className="grow" /><time>{ago(t.updated, now)}</time></span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
      {creating && <NewTask onClose={() => setCreating(false)} />}
    </>
  );
}

function Assignee({ value, onChange, none }: { value: string; onChange: (v: string) => void; none: string }) {
  const { board } = useCtx();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      <optgroup label="Agents">
        {board.agents.filter((a) => a.status === 'active').map((a) => <option key={a.id} value={a.id}>{a.name}{a.online ? '' : ' (offline)'}</option>)}
      </optgroup>
      <optgroup label="People">
        {board.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </optgroup>
    </select>
  );
}

function NewTask({ onClose, parent = '' }: { onClose: () => void; parent?: string }) {
  const { act, open } = useCtx();
  const { board } = useCtx();
  const [f, setF] = useState({ title: '', outcome: '', body: '', next: '', assignee: '', participants: '', private: false, priority: 1, review: 'required' });
  const set = (change: Partial<typeof f>): void => setF({ ...f, ...change });
  const submit = async (): Promise<void> => {
    let made: Row | null = null;
    if (await act(async () => void (made = await api.call('create_task', { ...f, ...(parent ? { parent } : {}) })))) {
      onClose();
      if (made !== null && !parent) open('tasks', (made as Row).id);
    }
  };
  return (
    <Modal title={parent ? `New subtask of ${parent}` : 'New task'} onClose={onClose}>
      <Form onSubmit={submit} submit="Create task">
        <Field label="Title"><input value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} required autoFocus /></Field>
        <Field label="Outcome" hint="What can be observed when it is done: the thing a reviewer will check."><textarea value={f.outcome} onChange={(e) => set({ outcome: e.target.value })} rows={2} maxLength={2000} required /></Field>
        <Field label="Description" hint="Everything the one doing it needs: context, where things are."><textarea value={f.body} onChange={(e) => set({ body: e.target.value })} rows={4} maxLength={20000} /></Field>
        <Field label="Next action"><input value={f.next} onChange={(e) => set({ next: e.target.value })} maxLength={500} /></Field>
        <Field label="Participants" hint={`Names separated by spaces. Here: ${[...board.agents.filter((a) => a.status === 'active'), ...board.people].map((a) => a.name).join(', ') || 'nobody yet'}`}><input value={f.participants} onChange={(e) => set({ participants: e.target.value })} maxLength={400} spellCheck={false} /></Field>
        <label className="check"><input type="checkbox" checked={f.private} onChange={(e) => set({ private: e.target.checked })} /> Private: only its creator, holder, reviewer and participants see it</label>
        <div className="row">
          <Field label="Assign to"><Assignee value={f.assignee} onChange={(assignee) => set({ assignee })} none="Anyone may claim it" /></Field>
          <Field label="Priority"><select value={f.priority} onChange={(e) => set({ priority: Number(e.target.value) })}>{PRIORITY.map((p, i) => <option key={p} value={i}>{p}</option>)}</select></Field>
          <Field label="Review"><select value={f.review} onChange={(e) => set({ review: e.target.value })}><option value="required">Required</option><option value="optional">Optional</option></select></Field>
        </div>
      </Form>
    </Modal>
  );
}

function TaskDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { act, tick, board, me, open } = useCtx();
  const [d, setD] = useState<{ task: Row; thread: Row[]; evidence: Row[]; reviews: Row[]; subtasks: Row[]; cost: number } | null>(null);
  const [result, setResult] = useState('');
  const [proof, setProof] = useState('');
  const [missing, setMissing] = useState('');
  const [comment, setComment] = useState('');
  const [verdict, setVerdict] = useState('');
  const [to, setTo] = useState('');
  const [sub, setSub] = useState(false);
  useEffect(() => void api.call('get_task', { task: id }).then(setD, (e: Error) => setMissing(e.message)), [id, tick]);
  if (missing) return <Modal title={id} onClose={onClose}><div className="form"><p className="error">{missing}</p></div></Modal>;
  if (d === null) return null;
  const t = d.task;
  const live = t.status !== 'done' && t.status !== 'cancelled';
  const review = d.reviews.find((r) => r.status === 'pending');
  const run = (action: string, params: Row = {}) => () => void act(() => api.call(action, { task: t.id, ...params }));
  const say = async (): Promise<void> => {
    if (comment.trim() !== '' && (await act(() => api.call('post_message', { to: t.id, body: comment })))) setComment('');
  };
  const now = Date.parse(board.now);
  const decided = d.reviews.filter((r) => r.status !== 'pending');
  return (
    <>
      <header className="head">
        <nav className="crumbs"><button className="link" onClick={onClose}>Tasks</button><span>›</span><code>{t.id}</code></nav>
        <div className="grow" />
        {live && <button onClick={() => setSub(true)}>Add subtask</button>}
        {!live && <button onClick={run('reopen_task')}>Reopen</button>}
      </header>
      <div className="page">
        <article>
          <h1 className="title"><i className={`ring s-${t.status}`} />{t.title}</h1>
          {t.dependency && (
            <section className="callout">
              <h4><Badge status={t.status} /> on {t.dependency}</h4>
              <p>Next check: {t.check}</p>
            </section>
          )}
          {t.outcome && <><h4>Outcome</h4><Prose>{t.outcome}</Prose></>}
          {t.body && <><h4>Description</h4><Prose>{t.body}</Prose></>}
          {t.next && <><h4>Next action</h4><Prose>{t.next}</Prose></>}
          {t.result && <><h4>{t.status === 'cancelled' ? 'Reason' : 'Result'}</h4><Prose>{t.result}</Prose></>}

          {review && (
            <section className="callout">
              <h4>Review asked by <Who id={review.requester} />{review.reviewer ? <> of <Who id={review.reviewer} /></> : ', open to anyone'}</h4>
              <Prose>{review.note}</Prose>
              {review.requester !== me.id && (
                <>
                  <textarea value={verdict} onChange={(e) => setVerdict(e.target.value)} rows={2} placeholder="Your comment (required to request changes)" />
                  <div className="row end">
                    <button onClick={() => void act(() => api.call('review_task', { task: t.id, verdict: 'request_changes', comment: verdict })).then((ok) => ok && setVerdict(''))}>Request changes</button>
                    <button className="primary" onClick={() => void act(() => api.call('review_task', { task: t.id, verdict: 'approve', comment: verdict })).then((ok) => ok && setVerdict(''))}>Approve</button>
                  </div>
                </>
              )}
            </section>
          )}

          {d.subtasks.length > 0 && (
            <>
              <h4>Subtasks</h4>
              <div className="rows">
                {d.subtasks.map((s) => <button key={s.id} className="task-row" onClick={() => open('tasks', s.id)}><i className={`ring s-${s.status}`} /><code>{s.id}</code><span className="title">{s.title}</span><span className="grow" /><Who id={s.assignee} empty="unclaimed" /><Badge status={s.status} /></button>)}
              </div>
            </>
          )}

          <h4>Evidence and external actions</h4>
          {d.evidence.length === 0 && <p className="muted">Nothing is attached yet.</p>}
          <ul className="list plain">
            {d.evidence.map((e) => (
              <li key={e.id}><span className={`badge ${e.kind === 'external_action' ? 's-waiting' : ''}`}>{e.kind === 'external_action' ? `done outside: ${e.key}` : 'evidence'}</span><span className="grow wraps">{e.text}</span><Who id={e.author} /><time>{clock(e.ts)}</time></li>
            ))}
          </ul>
          {live && (
            <div className="composer">
              <input value={proof} onChange={(e) => setProof(e.target.value)} placeholder="Attach evidence: a commit, a test run, a link" maxLength={5000} />
              <button disabled={proof.trim() === ''} onClick={() => void act(() => api.call('add_evidence', { task: t.id, text: proof })).then((ok) => ok && setProof(''))}>Attach</button>
            </div>
          )}

          <h4>Comments <span className="muted">{d.thread.length || ''}</span></h4>
          {d.thread.length === 0 && <p className="muted">Nobody has written here yet.</p>}
          <div className="thread">
            {d.thread.map((m) => <div key={m.id} className="msg"><div className="row"><Who id={m.author} /><time>{clock(m.ts)}</time></div><Prose>{m.body}</Prose></div>)}
          </div>
          <div className="composer">
            <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder={`Comment on ${t.id}; @name notifies`} onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && void say()} />
            <button className="primary" onClick={() => void say()} disabled={comment.trim() === ''}>Send</button>
          </div>
        </article>

        <aside className="props">
          <h3>Properties</h3>
          <dl>
            <dt>Status</dt><dd><Badge status={t.status} /></dd>
            <dt>Held by</dt><dd><Who id={t.assignee} empty="nobody" /></dd>
            <dt>Created by</dt><dd><Who id={t.creator} /></dd>
            {t.participants && <><dt>Participants</dt><dd className="stack">{(t.participants as string).split(' ').map((p) => <Who key={p} id={p} />)}</dd></>}
            <dt>Priority</dt><dd>{PRIORITY[t.priority]}</dd>
            <dt>Review</dt><dd>{t.review}</dd>
            <dt>Visible to</dt><dd>{t.private === 1 ? <span className="lock">its parties only</span> : 'everyone'}</dd>
            {t.parent && <><dt>Part of</dt><dd><button className="link" onClick={() => open('tasks', t.parent)}>{t.parent}</button></dd></>}
            {d.cost > 0 && <><dt>Cost</dt><dd>{usd(d.cost)}</dd></>}
            <dt>Revision</dt><dd>{t.rev}</dd>
            <dt>Created</dt><dd>{ago(t.created, now)}</dd>
            <dt>Updated</dt><dd>{ago(t.updated, now)}</dd>
          </dl>

          {live && t.status !== 'in_review' && (
            <>
              <h3>Hand to</h3>
              <div className="row">
                <Assignee value={to} onChange={setTo} none="Choose…" />
                <button disabled={to === '' || to === t.assignee} onClick={() => void act(() => api.call('delegate_task', { task: t.id, to, rev: t.rev })).then((ok) => ok && setTo(''))}>Hand over</button>
              </div>
              {t.assignee !== '' && <button onClick={run('release_task', { rev: t.rev })}>Unassign</button>}
            </>
          )}
          {live && (
            <>
              <h3>Mark done</h3>
              <textarea value={result} onChange={(e) => setResult(e.target.value)} rows={2} placeholder="What came of it and what shows it" maxLength={20000} />
              <button disabled={result.trim() === ''} onClick={() => void act(() => api.call('complete_task', { task: t.id, result, rev: t.rev })).then((ok) => ok && setResult(''))}>Mark done</button>
              <button className="danger" onClick={run('cancel_task', { rev: t.rev })}>Cancel task</button>
            </>
          )}
          {decided.length > 0 && (
            <>
              <h3>Past reviews</h3>
              {decided.map((r) => <div key={r.id} className="past"><span className="row"><Badge status={r.status} /><Who id={r.decider} /></span><p className="muted">{r.comment || r.note}</p></div>)}
            </>
          )}
        </aside>
      </div>
      {sub && <NewTask parent={t.id} onClose={() => setSub(false)} />}
    </>
  );
}
