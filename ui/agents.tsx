import { useState } from 'react';
import { ago, api, usd, type Row } from './api';
import { Badge, Copy, Empty, Field, Form, Modal, Secret, useCtx } from './kit';

const origin = (): string => location.origin;

export function Agents() {
  const { board, act } = useCtx();
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState<{ name: string; token: string } | null>(null);
  const [key, setKey] = useState('');
  const [budgetOf, setBudgetOf] = useState<Row | null>(null);
  const [confirm, setConfirm] = useState<{ agent: Row; action: 'revoke_agent' | 'rotate_token' } | null>(null);
  const run = (action: string, agent: Row, more: Row = {}) => () => void act(() => api.call(action, { agent: agent.id, ...more }));
  const agents = [...board.agents].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || Number(a.status === 'revoked') - Number(b.status === 'revoked') || a.name.localeCompare(b.name));
  return (
    <>
      <header className="head">
        <h2>Agents</h2>
        <div className="grow" />
        <button className="primary" onClick={() => setAdding(true)}>Add agent</button>
      </header>
      {agents.length === 0 && <Empty>No agents yet. Add one and give it its token, or hand out an enrollment key and approve whoever asks to join.</Empty>}
      <div className="cards">
        {agents.map((a) => {
          const share = a.budget > 0 ? Math.min(1, a.spent / a.budget) : 0;
          return (
            <article key={a.id} className={`agent ${a.status}`}>
              <div className="row">
                <i className={`dot ${a.online ? 'on' : ''}`} title={a.online ? 'online' : 'offline'} />
                <b>{a.name}</b>
                <span className="muted">{a.kind}</span>
                <span className="grow" />
                <Badge status={a.status} />
              </div>
              <p className="muted about">{a.about || 'No description.'}</p>
              {a.reason && <p className="warn">{a.reason}</p>}
              <div className="budget" title={a.budget > 0 ? `${usd(a.spent)} of ${usd(a.budget)} this month` : `${usd(a.spent)} this month, no limit`}>
                <div className="bar"><i className={share >= 1 ? 'over' : share >= 0.8 ? 'near' : ''} style={{ width: `${share * 100}%` }} /></div>
                <span>{usd(a.spent)}{a.budget > 0 ? ` of ${usd(a.budget)}` : ' · no limit'}</span>
              </div>
              <div className="row wrap actions">
                {a.status === 'pending' && <button className="primary" onClick={run('approve_agent', a)}>Approve</button>}
                {a.status === 'active' && <button onClick={run('pause_agent', a)}>Pause</button>}
                {a.status === 'paused' && <button className="primary" onClick={run('resume_agent', a)}>Resume</button>}
                {a.status !== 'revoked' && <button onClick={() => setBudgetOf(a)}>Budget</button>}
                {a.status !== 'revoked' && <button onClick={() => setConfirm({ agent: a, action: 'rotate_token' })}>New token</button>}
                {a.status !== 'revoked' && <button className="danger" onClick={() => setConfirm({ agent: a, action: 'revoke_agent' })}>{a.status === 'pending' ? 'Reject' : 'Revoke'}</button>}
                <span className="grow" />
                <time>joined {ago(a.created, Date.parse(board.now))}</time>
              </div>
            </article>
          );
        })}
      </div>

      <section className="panel enroll">
        <h3>Enrollment</h3>
        <p className="muted">
          With the enrollment key an agent can ask to join by itself. It gets a token at once but can only read until a person approves it here.
          Enrollment is <b>{board.enrollment ? 'open' : 'closed'}</b>.
        </p>
        <div className="row">
          <button onClick={() => void act(async () => setKey((await api.call<{ key: string }>('new_enrollment_key')).key))}>{board.enrollment ? 'Replace the key' : 'Make a key'}</button>
          {board.enrollment && <button onClick={() => void act(() => api.call('disable_enrollment'))}>Close enrollment</button>}
        </div>
      </section>

      {adding && <AddAgent onClose={() => setAdding(false)} onMade={(made) => { setAdding(false); setToken(made); }} />}
      {token && <Secret title={`Token for ${token.name}`} value={token.token} onClose={() => setToken(null)}><Connect token={token.token} /></Secret>}
      {key && (
        <Secret title="Enrollment key" value={key} onClose={() => setKey('')}>
          <p className="muted">An agent asks to join with:</p>
          <Copy text={`curl -sS ${origin()}/api/register -H 'Content-Type: application/json' -d '{"key":"${key}","name":"my-agent","kind":"claude-code","about":"what I am good at"}'`} />
        </Secret>
      )}
      {budgetOf && <Budget agent={budgetOf} onClose={() => setBudgetOf(null)} />}
      {confirm && (
        <Modal title={confirm.action === 'revoke_agent' ? `Revoke ${confirm.agent.name}?` : `New token for ${confirm.agent.name}?`} onClose={() => setConfirm(null)}>
          <Form
            danger
            submit={confirm.action === 'revoke_agent' ? 'Revoke for good' : 'Replace the token'}
            onSubmit={async () => {
              const { agent, action } = confirm;
              await act(async () => {
                const made = await api.call<{ token?: string }>(action, { agent: agent.id });
                if (made.token) setToken({ name: agent.name, token: made.token });
              });
              setConfirm(null);
            }}
          >
            <p>{confirm.action === 'revoke_agent' ? 'Its token stops working at once and it cannot be brought back. What it did stays in the audit log.' : 'The token it has now stops working at once.'}</p>
          </Form>
        </Modal>
      )}
    </>
  );
}

function Connect({ token }: { token: string }) {
  return (
    <>
      <p className="muted">Connect Claude Code:</p>
      <Copy text={`claude mcp add --transport http rayboard ${origin()}/mcp --header "Authorization: Bearer ${token}"`} />
      <p className="muted">Any other MCP client: streamable HTTP at <code>{origin()}/mcp</code> with the header <code>Authorization: Bearer …</code>. Without MCP: <code>POST {origin()}/api/call/&lt;action&gt;</code> with the same header; <code>GET /api/actions</code> lists them.</p>
    </>
  );
}

function AddAgent({ onClose, onMade }: { onClose: () => void; onMade: (made: { name: string; token: string }) => void }) {
  const { act } = useCtx();
  const [f, setF] = useState({ name: '', kind: 'claude-code', about: '', budget: 0 });
  const set = (change: Partial<typeof f>): void => setF({ ...f, ...change });
  return (
    <Modal title="Add agent" onClose={onClose}>
      <Form submit="Add and show token" onSubmit={() => act(async () => { const made = await api.call<{ agent: Row; token: string }>('create_agent', f); onMade({ name: made.agent.name, token: made.token }); })}>
        <Field label="Name" hint="2 to 32 of a-z, 0-9, - and _. Others address it as @name."><input value={f.name} onChange={(e) => set({ name: e.target.value })} required autoFocus maxLength={32} spellCheck={false} /></Field>
        <div className="row">
          <Field label="Runs on"><input value={f.kind} onChange={(e) => set({ kind: e.target.value })} maxLength={40} /></Field>
          <Field label="Budget, $ a month" hint="0 for no limit"><input type="number" min={0} step="any" value={f.budget} onChange={(e) => set({ budget: Number(e.target.value) })} /></Field>
        </div>
        <Field label="What it is good at" hint="Other agents read this to decide whom to delegate to."><textarea value={f.about} onChange={(e) => set({ about: e.target.value })} rows={3} maxLength={500} /></Field>
      </Form>
    </Modal>
  );
}

function Budget({ agent, onClose }: { agent: Row; onClose: () => void }) {
  const { act } = useCtx();
  const [value, setValue] = useState<number>(agent.budget);
  return (
    <Modal title={`Budget of ${agent.name}`} onClose={onClose}>
      <Form submit="Set budget" onSubmit={async () => { if (await act(() => api.call('set_budget', { agent: agent.id, usd: value }))) onClose(); }}>
        <Field label="US dollars a month" hint={`Spent this month: ${usd(agent.spent)}. At the limit the agent is paused until a person resumes it. 0 for no limit.`}>
          <input type="number" min={0} step="any" value={value} onChange={(e) => setValue(Number(e.target.value))} autoFocus />
        </Field>
      </Form>
    </Modal>
  );
}
