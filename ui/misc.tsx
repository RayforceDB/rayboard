import { useEffect, useState } from 'react';
import { ago, api, clock, usd, type Row } from './api';
import { Busy, Empty, Who, mayDecide, useCtx } from './kit';
import { imageHandlers } from './images';
import { Prose } from './prose';

function ReviewCard({ review }: { review: Row }) {
  const { board, open, me, act } = useCtx();
  const task = board.tasks.find((t) => t.id === review.task);
  const [verdict, setVerdict] = useState('');
  const [deciding, setDeciding] = useState(false);
  // A named reviewer, or anyone allowed an open review, decides without opening the task drawer.
  // The server checks this again; an administrator is not an implicit substitute for a named reviewer.
  const may = me.role !== 'viewer' && mayDecide(review, me, board.tasks);
  const decide = (choice: 'approve' | 'request_changes') => async (): Promise<void> => {
    setDeciding(true);
    try {
      const ok = await act(() => api.call('review_task', { task: review.task, verdict: choice, comment: verdict }));
      if (ok) setVerdict('');
    } finally {
      setDeciding(false);
    }
  };
  return (
    <article className="agent review-card">
      <button className="link review-open" onClick={() => open('tasks', review.task)} title="Open the task and its discussion">
        <span className="row"><code>{review.task}</code><b className="grow">{task?.title ?? review.task}</b><time>{ago(review.created, Date.parse(board.now))}</time></span>
      </button>
      <p className="muted byline"><span>by</span><Who id={review.requester} size={20} />{review.reviewer ? <><span>· asked of</span><Who id={review.reviewer} size={20} /></> : <span>· open to anyone but its author</span>}</p>
      <Prose>{review.note}</Prose>
      {may && (
        <div className="review-decision">
          <textarea aria-label={`Comment on ${review.task}`} value={verdict} {...imageHandlers(verdict, setVerdict, act)} onChange={(e) => setVerdict(e.target.value)} rows={2} maxLength={20000} placeholder="Your comment (required to request changes)" />
          <div className="row end">
            <Busy run={decide('request_changes')} busy={deciding} disabled={verdict.trim() === ''} label="Request changes" doing="Sending…" />
            <Busy className="primary" run={decide('approve')} busy={deciding} label="Approve" doing="Approving…" />
          </div>
        </div>
      )}
    </article>
  );
}

export function Reviews() {
  const { board, me } = useCtx();
  // The sidebar counts the first group; the second is shown so that nothing waiting is hidden.
  const yours = board.reviews.filter((r) => mayDecide(r, me, board.tasks));
  const others = board.reviews.filter((r) => !mayDecide(r, me, board.tasks));
  const card = (r: Row) => <ReviewCard key={r.id} review={r} />;
  return (
    <>
      <header className="head"><h2>Reviews</h2></header>
      {board.reviews.length === 0 && <Empty>No review is waiting. When an agent finishes a task that needs review, it appears here.</Empty>}
      {board.reviews.length > 0 && <>
        <h3 className="reviews-group">Waiting for your verdict<span className="count-pill">{yours.length}</span></h3>
        {yours.length === 0 ? <p className="muted">Nothing waits for you.</p> : <div className="cards reviews">{yours.map(card)}</div>}
        {others.length > 0 && <>
          <h3 className="reviews-group">Waiting for someone else<span className="count-pill">{others.length}</span></h3>
          <p className="muted">Asked of another reviewer, or of your own work.</p>
          <div className="cards reviews">{others.map(card)}</div>
        </>}
      </>}
    </>
  );
}

export function Costs() {
  const { board, tick, name } = useCtx();
  const [data, setData] = useState<{ month: Row[]; days: Row[] } | null>(null);
  useEffect(() => void api.call('costs').then(setData, () => {}), [tick]);
  if (data === null) return null;
  const total = data.month.reduce((sum, r) => sum + r.usd, 0);
  // One bar a day for the last 30 days, the days without spending among them.
  const today = Date.parse(`${board.now.slice(0, 10)}T00:00:00Z`);
  const byDay = new Map<string, number>();
  for (const r of data.days) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.usd);
  const days = Array.from({ length: 30 }, (_, i) => new Date(today - (29 - i) * 86_400_000).toISOString().slice(0, 10));
  const top = Math.max(...days.map((d) => byDay.get(d) ?? 0), 0.01);
  const budgets = new Map(board.agents.map((a) => [a.id, a.budget as number]));
  return (
    <>
      <header className="head"><h2>Costs</h2><div className="grow" /><span className="muted">{usd(total)} this month, as the agents reported it</span></header>
      <section className="panel">
        <h3>Per day, last 30 days</h3>
        <div className="chart" role="img" aria-label="Spending per day">
          {days.map((d) => <div key={d} className="col" title={`${d}: ${usd(byDay.get(d) ?? 0)}`}><i className={byDay.get(d) ? '' : 'zero'} style={{ height: `${((byDay.get(d) ?? 0) / top) * 100}%` }} /></div>)}
        </div>
        <div className="row axis"><span>{days[0]}</span><span className="grow" /><span>peak {usd(top === 0.01 ? 0 : top)}</span><span className="grow" /><span>{days[29]}</span></div>
      </section>
      <section className="panel">
        <h3>Per agent, this month</h3>
        {data.month.length === 0 && <Empty>No agent has reported a cost this month. They do it with <code>report_cost</code>.</Empty>}
        {data.month.length > 0 && (
          <table>
            <thead><tr><th>Agent</th><th className="num">Spent</th><th className="num">Budget</th><th className="num">Tokens in</th><th className="num">Tokens out</th><th className="num">Reports</th></tr></thead>
            <tbody>
              {[...data.month].sort((a, b) => b.usd - a.usd).map((r) => (
                <tr key={r.agent}><td>{name(r.agent)}</td><td className="num">{usd(r.usd)}</td><td className="num">{budgets.get(r.agent) ? usd(budgets.get(r.agent)!) : 'none'}</td><td className="num">{r.tokens_in.toLocaleString()}</td><td className="num">{r.tokens_out.toLocaleString()}</td><td className="num">{r.reports}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

export function Activity() {
  const { tick, open } = useCtx();
  const [rows, setRows] = useState<Row[]>([]);
  const [limit, setLimit] = useState(100);
  useEffect(() => void api.call<Row[]>('activity', { limit }).then(setRows, () => {}), [tick, limit]);
  return (
    <>
      <header className="head"><h2>Audit log</h2><div className="grow" /><span className="muted">every accepted change, from the journal</span></header>
      {rows.length === 0 && <Empty>Nothing has happened yet.</Empty>}
      {rows.length > 0 && (
        <section className="panel flush">
          <table>
            <thead><tr><th className="num">#</th><th>When</th><th>Who</th><th>What</th><th>Summary</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.seq} className={/^T-/.test(e.subject) ? 'clickable' : ''} onClick={() => /^T-/.test(e.subject) && open('tasks', e.subject)}>
                  <td className="num muted">{e.seq}</td><td className="nowrap">{clock(e.ts)}</td><td><Who id={e.actor} /></td><td><code>{e.type}</code></td><td>{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === limit && limit < 500 && <div className="row pad"><button onClick={() => setLimit(500)}>Show more</button></div>}
        </section>
      )}
    </>
  );
}
