import { useEffect, useRef, useState } from 'react';
import { type CSSProperties } from 'react';
import { api, clock, type Row } from './api';
import { Empty, Field, Form, Modal, Who, useCtx } from './kit';
import { Prose } from './prose';
import { MentionInput } from './mention';
import { ResizeHandle, panelWidth } from './resize';

export function Chat({ item }: { item: string }) {
  const { board, tick, act, open, me, name, unread, markRead } = useCtx();
  const [messages, setMessages] = useState<Row[]>([]);
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [listWidth, setListWidth] = useState(() => panelWidth('conversations', 220, 180, 360));
  const end = useRef<HTMLDivElement>(null);
  const current = item || (board.channels[0]?.id as string | undefined) || '';
  const channel = board.channels.find((c) => c.id === current);
  const dmLabel = (chan: string): string => chan.split(':').slice(1).filter((id) => id !== me.id).map(name).join(' and ');
  const mine = (chan: string): boolean => chan.split(':').includes(me.id);

  useEffect(() => {
    if (current === '') return setMessages([]);
    void api.call<Row[]>('read_messages', { from: current, limit: 200 }).then((next) => { setMessages(next); const last=next[next.length-1]; if(last) markRead(current,Number(last.seq)); }, () => setMessages([]));
  }, [current, tick, markRead]);
  // In braces on purpose: newer browsers return a promise from scrollIntoView, and whatever an effect
  // returns React calls as its cleanup when the view is left.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, current]);

  const canWrite = me.role !== 'viewer' && (channel !== undefined || mine(current) || current.startsWith('@'));
  const send = async (): Promise<void> => {
    if (text.trim() === '') return;
    const to = current.startsWith('dm:') ? `@${dmLabel(current)}` : current;
    if (await act(() => api.call('post_message', { to, body: text }))) setText('');
  };
  const others = [...board.agents.filter((a) => a.status !== 'revoked'), ...board.people].filter((a) => a.id !== me.id);
  const dmOf = (id: string): string => `dm:${[me.id, id].sort().join(':')}`;
  const watched = board.dms.filter((d) => !mine(d.chan));

  return (
    <div className="chat" style={{ gridTemplateColumns: `${listWidth}px minmax(0, 1fr)`, '--conversation-width': `${listWidth}px` } as CSSProperties}>
      <aside>
        <h3>Channels {me.role !== 'viewer' && <button className="ghost icon" onClick={() => setCreating(true)} aria-label="New channel">+</button>}</h3>
        {board.channels.length === 0 && <p className="muted pad">No channels yet.</p>}
        {board.channels.map((c) => <button key={c.id} className={`${c.id === current ? 'on' : ''} ${unread(c) ? 'unread' : ''}`} onClick={() => open('chat', c.id)}><span className="grow"># {c.name}</span><span className="muted">{c.messages || ''}</span></button>)}
        <h3>Direct</h3>
        {others.map((a) => <button key={a.id} className={`${dmOf(a.id) === current ? 'on' : ''} ${unread(board.dms.find((d)=>d.chan===dmOf(a.id))??{}) ? 'unread' : ''}`} onClick={() => open('chat', dmOf(a.id))}><Who id={a.id} /></button>)}
        {watched.length > 0 && <h3>Between agents</h3>}
        {watched.map((d) => <button key={d.chan} className={`${d.chan === current ? 'on' : ''} ${unread(d) ? 'unread' : ''}`} onClick={() => open('chat', d.chan)}><span className="grow">{dmLabel(d.chan)}</span><span className="muted">{d.n}</span></button>)}
      </aside>
      <ResizeHandle name="conversation list" value={listWidth} setValue={setListWidth} min={180} max={360} />
      <section>
        <header className="head">
          <h2>{channel ? `# ${channel.name}` : current.startsWith('dm:') ? dmLabel(current) : 'Messages'}</h2>
          {channel?.topic && <span className="muted">{channel.topic}</span>}
          {current.startsWith('dm:') && !mine(current) && <span className="muted">a conversation between agents, shown to you as an overseer</span>}
        </header>
        <div className="scroll">
          {current === '' && <Empty>Open a channel so agents and people have somewhere to talk.</Empty>}
          {current !== '' && messages.length === 0 && <Empty>Nothing here yet.</Empty>}
          {messages.map((m) => <div key={m.id} className={`msg ${m.author !== me.id && unread({...m,last:m.seq}) ? 'new-post' : ''}`}><div className="row"><Who id={m.author} /><time>{clock(m.ts)}</time></div><Prose>{m.body}</Prose></div>)}
          <div ref={end} />
        </div>
        {current !== '' && canWrite && (
          <div className="composer">
            <MentionInput value={text} onChange={setText} onSend={() => void send()} placeholder="Write a message; @name notifies. Ctrl+Enter sends." />
            <button className="primary" onClick={() => void send()} disabled={text.trim() === ''}>Send</button>
          </div>
        )}
      </section>
      {creating && <NewChannel onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewChannel({ onClose }: { onClose: () => void }) {
  const { act, open } = useCtx();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const submit = async (): Promise<void> => {
    let made: Row | null = null;
    if (await act(async () => void (made = await api.call('create_channel', { name, topic })))) {
      onClose();
      if (made !== null) open('chat', (made as Row).id);
    }
  };
  return (
    <Modal title="New channel" onClose={onClose}>
      <Form onSubmit={submit} submit="Open channel">
        <Field label="Name" hint="2 to 32 of a-z, 0-9, - and _"><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={32} spellCheck={false} /></Field>
        <Field label="Topic"><input value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={300} /></Field>
      </Form>
    </Modal>
  );
}
