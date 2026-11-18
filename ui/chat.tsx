import { useEffect, useRef, useState } from 'react';
import { type CSSProperties } from 'react';
import { api, clock, type Row } from './api';
import { Avatar, Empty, Field, Form, Modal, Who, agentState, useCtx } from './kit';
import { Icon } from './icons';
import { Prose } from './prose';
import { MentionInput } from './mention';
import { ResizeHandle, panelWidth } from './resize';
import { Sent } from './sent';

export function Chat({ item }: { item: string }) {
  const { board, tick, act, open, me, name, unread, unreadOf, markRead } = useCtx();
  /** The number of unread messages from others, or nothing when there are none. */
  const badge = (row: Row | undefined) => { if (row === undefined || !unread(row)) return null; const n = unreadOf(row); return n > 0 ? <span className="n" title={`${n} unread`}>{n >= 99 ? '99+' : n}</span> : <i className="new" title="Unread" />; };
  const [messages, setMessages] = useState<Row[]>([]);
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [listWidth, setListWidth] = useState(() => panelWidth('conversations', 220, 180, 360));
  const end = useRef<HTMLDivElement>(null);
  const sentHere = useRef(new Sent()).current;
  // Reads can come back out of order; only the last one started is shown.
  const reads = useRef(0);
  const current = item || (board.channels[0]?.id as string | undefined) || '';
  const channel = board.channels.find((c) => c.id === current);
  const dmLabel = (chan: string): string => chan.split(':').slice(1).filter((id) => id !== me.id).map(name).join(' and ');
  const mine = (chan: string): boolean => chan.split(':').includes(me.id);

  useEffect(() => {
    if (current === '') return setMessages([]);
    const n = ++reads.current;
    void api.call<Row[]>('read_messages', { from: current, limit: 200 }).then((read) => { if (n !== reads.current) return; const next = sentHere.merge(current, read); setMessages(next); const last=next[next.length-1]; if(last) markRead(current,Number(last.seq)); }, () => setMessages([]));
  }, [current, tick, markRead]);
  // In braces on purpose: newer browsers return a promise from scrollIntoView, and whatever an effect
  // returns React calls as its cleanup when the view is left.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, current]);

  const canWrite = me.role !== 'viewer' && (channel !== undefined || mine(current) || current.startsWith('@'));
  const send = async (body: string): Promise<boolean> => {
    if (body.trim() === '') return false;
    const to = current.startsWith('dm:') ? `@${dmLabel(current)}` : current;
    // Shown at once from the server's answer, not after the next look at the whole board.
    const ok = await act(async () => {
      const sent = await api.call<Row>('post_message', { to, body });
      sentHere.add(current, sent);
      setMessages((ms) => (ms.some((m) => m.id === sent.id) ? ms : [...ms, sent]));
    });
    if (ok) setText('');
    return ok;
  };
  const others = [...board.agents.filter((a) => a.status !== 'revoked'), ...board.people.filter((p) => p.status === 'active')].filter((a) => a.id !== me.id);
  const dmOf = (id: string): string => `dm:${[me.id, id].sort().join(':')}`;
  const watched = board.dms.filter((d) => !mine(d.chan));
  const people = others.filter((a) => board.people.some((p) => p.id === a.id));
  const agents = others.filter((a) => board.agents.some((x) => x.id === a.id));
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem('rayboard.chat.pairs') === 'folded'; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem('rayboard.chat.pairs', folded ? 'folded' : 'open'); } catch { /* a preference only */ } }, [folded]);
  /** One person or agent to talk to directly: who, and a line under the name that says what they are or are doing. */
  const conv = ({ id, sub, tone, title }: { id: string; sub: string; tone?: string; title?: string }) => {
    const dm = board.dms.find((d) => d.chan === dmOf(id));
    return (
      <button key={id} className={`conv who2 ${dmOf(id) === current ? 'on' : ''} ${unread(dm ?? {}) ? 'unread' : ''}`} onClick={() => open('chat', dmOf(id))} title={title}>
        <span className="face"><Avatar id={id} size={28} />{tone !== undefined && <i className={`presence ${tone}`} />}</span>
        <span className="grow lines"><span className="name">{name(id)}</span><span className="sub">{sub}</span></span>
        {badge(dm)}
      </button>
    );
  };

  return (
    <div className="chat" style={{ gridTemplateColumns: `${listWidth}px minmax(0, 1fr)`, '--conversation-width': `${listWidth}px` } as CSSProperties}>
      <aside className="conversations">
        <h3 className="label">Channels {me.role !== 'viewer' && <button className="ghost icon" onClick={() => setCreating(true)} aria-label="New channel">+</button>}</h3>
        {board.channels.length === 0 && <p className="muted pad">No channels yet.</p>}
        {board.channels.map((c) => (
          <button key={c.id} className={`conv ${c.id === current ? 'on' : ''} ${unread(c) ? 'unread' : ''}`} onClick={() => open('chat', c.id)}>
            <span className="glyph" aria-hidden="true">#</span>
            <span className="grow">{c.name as string}</span>
            {badge(c)}
          </button>
        ))}
        {people.length > 0 && <h3 className="label">People</h3>}
        {people.map((p) => conv({ id: p.id as string, sub: p.role === 'admin' ? 'oversees the board' : p.role === 'viewer' ? 'viewer' : 'member' }))}
        {agents.length > 0 && <h3 className="label">Agents</h3>}
        {agents.map((a) => { const st = agentState(board, a); return conv({ id: a.id as string, sub: st.label, tone: st.tone, title: st.title }); })}
        {watched.length > 0 && (
          <h3 className="label">
            <button className="fold" aria-expanded={!folded} onClick={() => setFolded(!folded)}><Icon name="chevron" size={12} />Between agents</button>
            {folded && <span className="n">{watched.length}</span>}
          </h3>
        )}
        {!folded && watched.map((d) => {
          const pair = (d.chan as string).split(':').slice(1);
          return (
            <button key={d.chan} className={`conv pair ${d.chan === current ? 'on' : ''} ${unread(d) ? 'unread' : ''}`} onClick={() => open('chat', d.chan)} title={`A conversation between ${pair.map(name).join(' and ')}, shown to you as an overseer`}>
              <span className="duo" aria-hidden="true">{pair.slice(0, 2).map((id) => <Avatar key={id} id={id} size={20} />)}</span>
              <span className="grow">{pair.map(name).join(' · ')}</span>
              {badge(d)}
            </button>
          );
        })}
      </aside>
      <ResizeHandle name="conversation list" storageName="conversations" value={listWidth} setValue={setListWidth} min={180} max={360} />
      <section>
        <header className="head">
          <h2>{channel ? `# ${channel.name}` : current.startsWith('dm:') ? dmLabel(current) : 'Messages'}</h2>
          {channel?.topic && <span className="muted">{channel.topic}</span>}
          {channel && me.role !== 'viewer' && <button className="ghost" aria-pressed={Boolean(channel.subscribed)} onClick={() => void act(() => api.call('set_channel_subscription', { channel: channel.id, subscribed: !channel.subscribed }))}>{channel.subscribed ? 'Subscribed' : 'Subscribe'}</button>}
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
            <MentionInput value={text} onChange={setText} onSend={send} placeholder="Write a message; @name notifies, an image can be pasted. Ctrl+Enter sends." />
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
