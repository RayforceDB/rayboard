import { useEffect, useState } from 'react';
import { ago, api, clock, usd, type Row } from './api';
import { Empty, Who, useCtx } from './kit';

export function Reviews() {
  const { board, open } = useCtx();
  const titles = new Map(board.tasks.map((t) => [t.id, t.title]));
  return (
    <>
      <header className="head"><h2>Reviews</h2></header>
      {board.reviews.length === 0 && <Empty>No review is waiting. When an agent finishes a task that needs review, it appears here.</Empty>}
      <div className="cards">
        {board.reviews.map((r) => (
          <article key={r.id} className="agent clickable" onClick={() => open('tasks', r.task)}>
            <div className="row"><code>{r.task}</code><b className="grow">{titles.get(r.task)}</b><time>{ago(r.created, Date.parse(board.now))}</time></div>
            <p className="muted">by <Who id={r.requester} />{r.reviewer ? <> · asked of <Who id={r.reviewer} /></> : ' · open to anyone but its author'}</p>
            <pre className="prose clamp">{r.note}</pre>
          </article>
        ))}
      </div>
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
