import { useEffect, useState, type DragEvent, type ReactNode } from 'react';
import { ago, api, clock, usd, when, type Row } from './api';
import { Icon } from './icons';
import { AgentStrip, Avatar, Badge, Empty, mayDecide, Field, Form, Menu, Modal, PRIORITY, Prio, STATUS_LABEL, StatusPill, Who, useCtx } from './kit';
import { Prose } from './prose';
import { MentionInput } from './mention';
import { ResizeHandle, panelWidth } from './resize';
import { NONE, inProject, projectsOf, useProject } from './projects';
import { GithubMark, ProjectMark, TaskNumber, useShownTitle } from './marks';
import { imageHandlers } from './images';

/** The lanes of the board. Waiting and blocked share one: both are work that stands still, and each card says which. */
const LANES = [
  { key: 'open', label: 'Backlog', has: ['open'] },
  { key: 'in_progress', label: 'In progress', has: ['in_progress', 'changes_requested'] },
  { key: 'waiting', label: 'Waiting', has: ['waiting', 'blocked'] },
  { key: 'in_review', label: 'Review', has: ['in_review'] },
  { key: 'done', label: 'Done', has: ['done'] },
] as const;
const CANCELLED = { key: 'cancelled', label: 'Cancelled', has: ['cancelled'] } as const;
/** Where each status stands in the work, for ordering a project's tasks: what moves first, finished work last. */
const ORDER = ['in_review', 'changes_requested', 'in_progress', 'blocked', 'waiting', 'open', 'done', 'cancelled'];

export function Tasks({ item }: { item: string }) {
  const { board, open, name, me, unread, markRead, act } = useCtx();
  /** Whether a new task is being made, and in which project when it was started from one. */
  const [creating, setCreating] = useState<boolean | string>(false);
  const [layout, setLayout] = useState<'list' | 'board'>(() => (localStorage.getItem('rb.layout') === 'list' ? 'list' : 'board'));
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState('');
  const [dropLane, setDropLane] = useState('');
  const [dropError, setDropError] = useState('');
  const [project, setProject] = useProject();
  const [group, setGroup] = useState<'status' | 'project'>(() => { try { return localStorage.getItem('rb.group') === 'project' ? 'project' : 'status'; } catch { return 'status'; } });
  const groupBy = (g: 'status' | 'project'): void => {
    setGroup(g);
    try { localStorage.setItem('rb.group', g); } catch { /* only a convenience */ }
  };
  const projects = projectsOf(board.tasks);
  const unfiled = board.tasks.filter((t) => !t.project).length;
  // A project chosen elsewhere and since emptied still filters, so it stays listed until another is chosen.
  const known = project === '' || project === NONE || projects.some((p) => p.name === project);
  const pick = (l: 'list' | 'board'): void => {
    setLayout(l);
    try { localStorage.setItem('rb.layout', l); } catch { /* only a convenience */ }
  };
  const cancelled = board.tasks.filter((t) => t.status === 'cancelled').length;
  const now = Date.parse(board.now);
  const comments = new Map((board.threads ?? []).map((r) => [r.chan as string, r.n as number]));
  // The dashboard already folds comments, evidence and reviews into each task's last change.
  // Only work still going on is marked: it is what the sidebar counts, and a change to finished work asks nothing.
  const unreadRow = (t: Row) => t.status !== 'done' && t.status !== 'cancelled' && unread(t);
  const q = query.trim().toLowerCase();
  const shown = board.tasks.filter((t) => inProject(t, project) && (q === '' || `${t.id} ${t.title} ${name(t.assignee)} ${t.project ?? ''}`.toLowerCase().includes(q)));
  const lanesOf = (among: Row[]) => [...LANES, ...(showAll ? [CANCELLED] : [])].map((lane) => {
    const tasks = among.filter((t) => (lane.has as readonly string[]).includes(t.status));
    const ordered = lane.key === 'done' || lane.key === 'cancelled' ? tasks.slice(0, 30) : tasks.sort((x, y) => y.priority - x.priority || y.seq - x.seq);
    return { ...lane, tasks: ordered, total: tasks.length };
  });
  const lanes = lanesOf(shown);
  /** The tasks shown, by project: projects by name, then those without one. Finished work is counted but not what orders them. */
  const byProject = (() => {
    const visible = shown.filter((t) => showAll || t.status !== 'cancelled');
    const names = [...new Set(visible.map((t) => (t.project as string | undefined) ?? ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    return names.map((key) => {
      const tasks = visible.filter((t) => ((t.project as string | undefined) ?? '') === key)
        .sort((x, y) => ORDER.indexOf(x.status) - ORDER.indexOf(y.status) || y.priority - x.priority || y.seq - x.seq);
      return { key, label: key || 'Tasks without a project', tasks, open: tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length };
    });
  })();
  const tagProject = group === 'status' && project === '';
  const canDrag = (t: Row): boolean => me.kind === 'agent' ? t.creator === me.id || t.assignee === me.id : me.role !== 'viewer';
  const drag = (e: DragEvent, t: Row): void => { setDragging(t.id as string); setDropError(''); e.dataTransfer.setData('application/x-rayboard-task', t.id as string); e.dataTransfer.effectAllowed = 'move'; };
  const drop = async (e: DragEvent, lane: any): Promise<void> => {
    e.preventDefault(); const id = e.dataTransfer.getData('application/x-rayboard-task') || dragging;
    const t = board.tasks.find((x) => x.id === id); setDragging(''); setDropLane('');
    if (!t || t.status === lane.key || (lane.key === 'waiting' && ['waiting','blocked'].includes(t.status as string)) || (lane.key === 'in_progress' && t.status === 'changes_requested')) return;
    const status = lane.key as string; let note: string | undefined; let reviewer: string | undefined;
    if (status === 'waiting' || status === 'blocked') { note = window.prompt('What does this wait for, and when should it be checked next?')?.trim(); if (!note) return; }
    if (status === 'in_review') { reviewer = window.prompt('Reviewer name or id; leave blank for anyone but yourself')?.trim() || undefined; }
    const ok = await act(() => api.call('move_task', { task: t.id, status, rev: t.rev, note, reviewer }));
    if (!ok) setDropError(`Could not move ${t.id}. Check its permissions, review and current revision.`);
  };
  /** A review this person can decide is the one thing on the board waiting on them. */
  const mine = new Set(board.reviews.filter((r) => mayDecide(r, me, board.tasks)).map((r) => r.task as string));
  /** Lanes of cards; `scope` keeps a drop target apart when the same lane is shown once per project. */
  const kanban = (of: ReturnType<typeof lanesOf>, scope: string) => (
    <div className="kanban">
      {of.map((lane) => (
        <section key={lane.key} className={`lane ${dropLane === `${scope}/${lane.key}` ? 'drop-target' : ''}`} onDragOver={(e) => { if (dragging && canDrag(board.tasks.find((x) => x.id === dragging)!)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropLane(`${scope}/${lane.key}`); } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropLane(''); }} onDrop={(e) => void drop(e, lane)}>
          <h3><span className={`lane-dot s-${lane.key}`} aria-hidden="true" />{lane.label}<span className="count-pill">{lane.total}</span>{lane.key === 'open' && me.role !== 'viewer' && <button className="ghost icon" aria-label="New task" onClick={() => setCreating(scope || (project !== NONE ? project : '') || true)}><Icon name="plus" /></button>}</h3>
          {lane.tasks.map((t) => (
            <button key={t.id} draggable={canDrag(t)} aria-grabbed={dragging === t.id} onDragStart={(e) => drag(e, t)} onDragEnd={() => { setDragging(''); setDropLane(''); }} className={`card-task s-${t.status} ${t.id === item ? 'on' : ''} ${unreadRow(t) ? 'unread' : ''} ${dragging === t.id ? 'dragging' : ''}`} onClick={() => open('tasks', t.id)}>
              <span className="row"><TaskNumber t={t} /><Badge status={t.status} /><span className="grow" /><Prio level={t.priority} />{unreadRow(t) && <span className="unread-chip" title="Changed by someone else since you last opened it">Updated</span>}</span>
              <b><Title t={t} /></b>
              <Tags t={t} project={tagProject} />
              <GithubTag id={t.id as string} />
              <span className="row"><Who id={t.assignee} empty="Unclaimed" size={20} /><span className="grow" /><span className="comments" title="comments"><Icon name="comment" />{comments.get(t.id) ?? 0}</span></span>
              {mine.has(t.id) && <span className="ask"><Icon name="alert" />Waiting for your input</span>}
              {t.dependency && <span className={`ask ${t.status === 'blocked' ? 'bad' : 'calm'}`}><Icon name={t.status === 'blocked' ? 'ban' : 'clock'} />{STATUS_LABEL[t.status]} on {t.dependency}</span>}
            </button>
          ))}
        </section>
      ))}
    </div>
  );

  return (
    <div className="board-view">
      <div className="board-main">
        <header className="title-bar">
          <div className="grow">
            <h1>Board</h1>
            <p className="muted">Shared work. Visible progress.</p>
          </div>
          <div className="seg" role="group" aria-label="Layout">
            <button className={layout === 'board' ? 'on' : ''} onClick={() => pick('board')}><Icon name="board" />Board</button>
            <button className={layout === 'list' ? 'on' : ''} onClick={() => pick('list')}><Icon name="list" />List</button>
          </div>
          <div className="seg" role="group" aria-label="Group by">
            <button className={group === 'status' ? 'on' : ''} onClick={() => groupBy('status')} title="Group by status">By status</button>
            <button className={group === 'project' ? 'on' : ''} onClick={() => groupBy('project')} title="Group by project">By project</button>
          </div>
          <select className="project-filter" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.open})</option>)}
            {!known && <option value={project}>{project} (0)</option>}
            {unfiled > 0 && <option value={NONE}>— without a project —</option>}
          </select>
          <label className="search"><Icon name="search" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tasks…" aria-label="Search tasks" /></label>
          {me.role !== 'viewer' && <button className="primary" onClick={() => setCreating(project !== NONE && project !== '' ? project : true)}><Icon name="plus" />New task</button>}
        </header>
        <AgentStrip />
        {cancelled > 0 && <label className="check cancelled-toggle"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show {cancelled} cancelled</label>}
        {board.tasks.length === 0 && <Empty>No tasks yet. Create one, or let an agent do it with <code>create_task</code>.</Empty>}
        {layout === 'board' && board.tasks.length > 0 && (
          <>
          {dropError && <p className="error" role="alert">{dropError}</p>}
          {group === 'status' && kanban(lanes, '')}
          {group === 'project' && byProject.map((g) => (
            <section key={g.key || NONE} className={`project-swim ${g.key ? '' : 'unfiled'}`} aria-label={g.key ? `Project ${g.label}` : g.label}>
              <h2>{g.key && <ProjectMark name={g.key} size={22} />}{g.label}<span className="count-pill" title={`${g.open} still going on of ${g.tasks.length}`}>{g.open}</span></h2>
              {kanban(lanesOf(g.tasks), g.key)}
            </section>
          ))}
          {shown.length === 0 && <Empty>No task here matches.</Empty>}
          </>
        )}
        {layout === 'list' && board.tasks.length > 0 && (
          <div className="groups">
            {(group === 'status' ? lanes.filter((g) => g.total > 0) : byProject.map((g) => ({ ...g, total: g.open }))).map((g) => (
              <section key={g.key || NONE}>
                <h3 className={group === 'project' && !g.key ? 'unfiled' : ''}>{group === 'status' ? <span className={`lane-dot s-${g.key}`} aria-hidden="true" /> : g.key ? <ProjectMark name={g.key} size={18} /> : null}{g.label}<span className="count-pill">{g.total}</span></h3>
                {g.tasks.map((t) => (
                  <button key={t.id} className={`task-row ${t.id === item ? 'on' : ''} ${unreadRow(t) ? 'unread' : ''}`} onClick={() => open('tasks', t.id)}>
                    <TaskNumber t={t} />
                    <span className="title"><Title t={t} /></span>
                    {tagProject && t.project && <span className="tag project-tag"><ProjectMark name={t.project as string} size={14} />{t.project}</span>}
                    {unreadRow(t) && <span className="unread-chip" title="Changed by someone else since you last opened it">Updated</span>}
                    {t.dependency && <span className="muted dep">{t.status} on {t.dependency}</span>}
                    {mine.has(t.id) && <span className="ask inline"><Icon name="alert" />your input</span>}
                    <span className="grow" />
                    <Badge status={t.status} />
                    {t.private === 1 && <Icon name="lock" className="muted" />}
                    <Prio level={t.priority} />
                    <Who id={t.assignee} empty="Unclaimed" />
                    <span className="comments"><Icon name="comment" />{comments.get(t.id) ?? 0}</span>
                    <time>{ago(t.updated, now)}</time>
                  </button>
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
      {item && <TaskDrawer key={item} id={item} onClose={() => open('tasks')} />}
      {creating !== false && <NewTask project={typeof creating === 'string' ? creating : ''} onClose={() => setCreating(false)} />}
    </div>
  );
}

/** What a card says about a task besides its title: where it belongs and who may see it. */
/** Where on GitHub a task comes from, and what GitHub says of it: shown beside the task, never as its status. */
export function GithubTag({ id }: { id: string }) {
  const { board } = useCtx();
  const g = (board.github ?? []).find((x) => x.task === id);
  if (!g) return null;
  const short = String(g.repo).split('/').pop();
  const checks = CHECKS[g.checks as string];
  const review = REVIEW[g.review as string];
  return (
    <span className="gh-line" onClick={(e) => e.stopPropagation()}>
      <a className={`gh-tag gh-${g.state}`} href={g.url} target="_blank" rel="noreferrer noopener" title={`Open ${short}#${g.number} on GitHub: ${g.kind === 'pr' ? 'pull request' : 'issue'} by @${g.author}`}>
        <GithubMark size={12} />{g.kind === 'pr' ? 'PR' : 'Issue'} {g.state}
      </a>
      {checks && <a className={`gh-tag gh-checks ${checks.tone}`} href={`${g.url}/checks`} target="_blank" rel="noreferrer noopener" title={checks.title}><Icon name={checks.icon} size={12} />{checks.label}</a>}
      {review && <span className={`gh-tag gh-review ${review.tone}`} title={review.title}><Icon name={review.icon} size={12} />{review.label}</span>}
      {(g.closed_by as number[] | undefined)?.length ? <span className="gh-tag" title="Pull requests that say they close this issue">PR #{(g.closed_by as number[]).join(', #')}</span> : null}
    </span>
  );
}

/** How a pull request's checks read on its card; none says nothing. */
const CHECKS: Record<string, { label: string; tone: string; icon: 'check' | 'x' | 'clock'; title: string }> = {
  success: { label: 'checks', tone: 'ok', icon: 'check', title: 'Every check on the head commit passed' },
  failure: { label: 'checks', tone: 'bad', icon: 'x', title: 'A check on the head commit failed' },
  pending: { label: 'checks', tone: 'wait', icon: 'clock', title: 'Checks on the head commit are still running' },
};
/** How a pull request's reviews read; only what decides anything is shown. */
const REVIEW: Record<string, { label: string; tone: string; icon: 'check' | 'undo'; title: string }> = {
  approved: { label: 'approved', tone: 'ok', icon: 'check', title: 'Approved on GitHub, and nobody asks for changes' },
  changes_requested: { label: 'changes requested', tone: 'bad', icon: 'undo', title: 'A reviewer asked for changes on GitHub' },
};

/** A GitHub task's links on the board: the issues a pull request closes, or the pull requests that close an issue. */
function GithubLinks({ id }: { id: string }) {
  const { board, open } = useCtx();
  const all = board.github ?? [];
  const g = all.find((x) => x.task === id);
  if (!g) return null;
  const numbers: number[] = g.kind === 'pr' ? (g.closes as number[] | undefined) ?? [] : (g.closed_by as number[] | undefined) ?? [];
  if (numbers.length === 0 && !g.head) return null;
  const short = String(g.repo).split('/').pop();
  return (
    <>
      <h4>On GitHub</h4>
      <dl className="props">
        {g.head && <><dt>Head</dt><dd><a href={`https://github.com/${g.repo}/commit/${g.head}`} target="_blank" rel="noreferrer noopener"><code>{String(g.head).slice(0, 7)}</code></a></dd></>}
        {numbers.length > 0 && <><dt>{g.kind === 'pr' ? 'Closes' : 'Closed by'}</dt><dd className="stack">{numbers.map((n) => {
          const other = all.find((x) => x.repo === g.repo && x.number === n);
          return other ? <button key={n} className="link" onClick={() => open('tasks', other.task)}>{short}#{n} · {other.task}</button> : <span key={n} className="muted">{short}#{n} (not on the board)</span>;
        })}</dd></>}
      </dl>
    </>
  );
}

/** A task's title as shown: a GitHub task's repo#number is its number, so it is not said twice. */
function Title({ t }: { t: Row }) {
  return <>{useShownTitle(t)}</>;
}

function Tags({ t, project = false }: { t: Row; project?: boolean }) {
  if (!t.parent && t.private !== 1 && !(project && t.project)) return null;
  return (
    <span className="tags">
      {project && t.project && <span className="tag project-tag"><ProjectMark name={t.project as string} size={14} />{t.project}</span>}
      {t.parent && <span className="tag"><Icon name="subtask" size={14} />in {t.parent}</span>}
      {t.private === 1 && <span className="tag"><Icon name="lock" size={14} />Private</span>}
    </span>
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
        {board.people.filter((p) => p.status === 'active').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </optgroup>
    </select>
  );
}

/** A project by name, offering the ones the board already has. */
function ProjectInput({ value, onChange, autoFocus = false }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const { board } = useCtx();
  return (
    <>
      <input value={value} onChange={(e) => onChange(e.target.value)} list="rb-projects" maxLength={64} spellCheck={false} autoCapitalize="none" pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" title="Letters, digits, ., - and _" autoFocus={autoFocus} />
      <datalist id="rb-projects">{projectsOf(board.tasks).map((p) => <option key={p.name} value={p.name} />)}</datalist>
    </>
  );
}

function NewTask({ onClose, parent = '', project = '' }: { onClose: () => void; parent?: string; project?: string }) {
  const { act, open } = useCtx();
  const { board } = useCtx();
  const above = parent ? board.tasks.find((t) => t.id === parent) : undefined;
  const [f, setF] = useState({ title: '', outcome: '', body: '', next: '', assignee: '', participants: '', private: false, priority: 1, review: 'required', project: project || ((above?.project as string | undefined) ?? '') });
  const set = (change: Partial<typeof f>): void => setF({ ...f, ...change });
  const submit = async (): Promise<void> => {
    let made: Row | null = null;
    const { project: chosen, ...rest } = f;
    if (await act(async () => void (made = await api.call('create_task', { ...rest, ...(chosen.trim() ? { project: chosen.trim() } : {}), ...(parent ? { parent } : {}) })))) {
      onClose();
      if (made !== null && !parent) open('tasks', (made as Row).id);
    }
  };
  return (
    <Modal title={parent ? `New subtask of ${parent}` : 'New task'} onClose={onClose}>
      <Form onSubmit={submit} submit="Create task">
        <Field label="Title"><input value={f.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} required autoFocus /></Field>
        <Field label="Outcome" hint="What can be observed when it is done: the thing a reviewer will check."><textarea value={f.outcome} {...imageHandlers(f.outcome, (outcome) => set({ outcome }), act)} onChange={(e) => set({ outcome: e.target.value })} rows={2} maxLength={2000} required /></Field>
        <Field label="Description" hint="Everything the one doing it needs: context, where things are."><textarea value={f.body} {...imageHandlers(f.body, (body) => set({ body }), act)} onChange={(e) => set({ body: e.target.value })} rows={4} maxLength={20000} /></Field>
        <Field label="Next action"><input value={f.next} onChange={(e) => set({ next: e.target.value })} maxLength={500} /></Field>
        <Field label="Project" hint="Such as rayforce or rayboard. Leave it empty for none."><ProjectInput value={f.project} onChange={(project) => set({ project })} /></Field>
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

function TaskDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { act, tick, board, me, open, name, markRead } = useCtx();
  const [d, setD] = useState<{ task: Row; thread: Row[]; evidence: Row[]; reviews: Row[]; subtasks: Row[]; cost: number } | null>(null);
  const [events, setEvents] = useState<Row[]>([]);
  const [tab, setTab] = useState<'discussion' | 'details' | 'activity'>('discussion');
  const [result, setResult] = useState('');
  const [proof, setProof] = useState('');
  const [missing, setMissing] = useState('');
  const [comment, setComment] = useState('');
  const [verdict, setVerdict] = useState('');
  const [to, setTo] = useState('');
  const [sub, setSub] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => void api.call('get_task', { task: id }).then((next) => { setD(next); markRead(id,Math.max(next.task.seq??0,...next.thread.map((m:Row)=>Number(m.seq??0)))); }, (e: Error) => setMissing(e.message)), [id, tick, markRead]);
  useEffect(() => {
    if (tab === 'activity') void api.call<Row[]>('activity', { subject: id, limit: 100 }).then(setEvents, () => setEvents([]));
  }, [id, tick, tab]);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.scrim')) onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const [width, setWidth] = useState(() => panelWidth('task', 400, 320, 720));
  const shell = (body: ReactNode) => <aside className="drawer" style={{ width }} aria-label={`Task ${id}`}><ResizeHandle name="task panel" storageName="task" value={width} setValue={setWidth} min={320} max={720} reverse />{body}</aside>;
  if (missing) return shell(<><header className="drawer-bar"><code>{id}</code><span className="grow" /><button className="ghost icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button></header><p className="error pad">{missing}</p></>);
  if (d === null) return shell(null);
  const t = d.task;
  const live = t.status !== 'done' && t.status !== 'cancelled';
  const review = d.reviews.find((r) => r.status === 'pending');
  const run = (action: string, params: Row = {}) => () => void act(() => api.call(action, { task: t.id, ...params }));
  const say = async (): Promise<void> => {
    if (comment.trim() !== '' && (await act(() => api.call('post_message', { to: t.id, body: comment })))) setComment('');
  };
  const now = Date.parse(board.now);
  const decided = d.reviews.filter((r) => r.status !== 'pending');
  const copyLink = (): void => void navigator.clipboard.writeText(`${location.origin}${location.pathname}#tasks/${encodeURIComponent(t.id)}`).then(() => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  });
  const menu = [
    ...(live ? [{ label: 'Add subtask', icon: 'subtask' as const, run: () => setSub(true) }] : []),
    ...(!live ? [] : []),
    ...(live ? [{ label: 'Cancel task', icon: 'ban' as const, danger: true, run: run('cancel_task', { rev: t.rev }) }] : []),
  ];

  return shell(
    <>
      <header className="drawer-bar">
        <code>{t.id}</code>
        <span className="grow" />
        <button className="ghost icon" onClick={copyLink} aria-label="Copy link" title={copied ? 'Copied' : 'Copy link'}><Icon name={copied ? 'check' : 'link'} /></button>
        <Menu items={menu} />
        <button className="ghost icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      </header>
      <div className="drawer-scroll">
        <div className="drawer-head">
          <h2><Title t={t} /></h2>
          <StatusPill status={t.status} />
          <GithubTag id={t.id as string} />
          {!live && me.role !== 'viewer' && <button onClick={run('reopen_task')}><Icon name="reopen" />Reopen task</button>}
          <div className="facts">
            <span className="muted"><Icon name="user" />Assignee</span>
            <Who id={t.assignee} empty="Unclaimed" />
            <i className="sep" />
            <Prio level={t.priority} />
            {t.private === 1 && <><i className="sep" /><span className="muted"><Icon name="lock" />Private</span></>}
            {t.parent && <><i className="sep" /><button className="link" onClick={() => open('tasks', t.parent)}>in {t.parent}</button></>}
            {t.project && <><i className="sep" /><span className="tag project-tag" title="Project"><ProjectMark name={t.project as string} size={14} />{t.project}</span></>}
          </div>
          {(t.body || t.outcome) && <Prose className="lead">{t.body || t.outcome}</Prose>}
          {t.dependency && (
            <section className={`callout ${t.status === 'blocked' ? 'bad' : ''}`}>
              <h4><Icon name={t.status === 'blocked' ? 'ban' : 'clock'} />{STATUS_LABEL[t.status]} on {t.dependency}</h4>
              {t.check && <p>Next check: {t.check}</p>}
            </section>
          )}
          {review && (
            <section className="callout ask-box">
              <h4><Icon name="alert" /><span className="byline"><span>Review asked by</span><Who id={review.requester} size={20} />{review.reviewer ? <><span>of</span><Who id={review.reviewer} size={20} /></> : <span>· open to anyone</span>}</span></h4>
              {review.note && <Prose>{review.note}</Prose>}
              {review.requester !== me.id && (
                <>
                  <textarea value={verdict} {...imageHandlers(verdict, setVerdict, act)} onChange={(e) => setVerdict(e.target.value)} rows={2} placeholder="Your comment (required to request changes)" />
                  <div className="row end">
                    <button onClick={() => void act(() => api.call('review_task', { task: t.id, verdict: 'request_changes', comment: verdict })).then((ok) => ok && setVerdict(''))}>Request changes</button>
                    <button className="primary" onClick={() => void act(() => api.call('review_task', { task: t.id, verdict: 'approve', comment: verdict })).then((ok) => ok && setVerdict(''))}>Approve</button>
                  </div>
                </>
              )}
            </section>
          )}
        </div>

        <nav className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'discussion'} className={tab === 'discussion' ? 'on' : ''} onClick={() => setTab('discussion')}><Icon name="comment" />Discussion ({d.thread.length})</button>
          <button role="tab" aria-selected={tab === 'details'} className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}><Icon name="list" />Details</button>
          <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}><Icon name="activity" />Activity</button>
        </nav>

        {tab === 'discussion' && (
          <div className="thread">
            {d.thread.length === 0 && <p className="muted pad">Nobody has written here yet.</p>}
            {d.thread.map((m) => (
              <div key={m.id} className="post">
                <Avatar id={m.author} size={32} />
                <div className="post-body">
                  <div className="row"><b>{name(m.author)}</b><time>{when(m.ts, now)}</time></div>
                  <Prose>{m.body}</Prose>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === 'details' && (
          <div className="details">
            {t.outcome && t.body && <><h4>Outcome</h4><Prose>{t.outcome}</Prose></>}
            {t.next && <><h4>Next action</h4><Prose>{t.next}</Prose></>}
            {t.result && <><h4>{t.status === 'cancelled' ? 'Reason' : 'Result'}</h4><Prose>{t.result}</Prose></>}

            {d.subtasks.length > 0 && (
              <>
                <h4>Subtasks</h4>
                <div className="rows">
                  {d.subtasks.map((s) => <button key={s.id} className="task-row" onClick={() => open('tasks', s.id)}><code>{s.id}</code><span className="title">{s.title}</span><span className="grow" /><Badge status={s.status} /></button>)}
                </div>
              </>
            )}

            <GithubLinks id={t.id as string} />
            <h4>Evidence and external actions</h4>
            {d.evidence.length === 0 && <p className="muted">Nothing is attached yet.</p>}
            <ul className="list plain">
              {d.evidence.map((e) => (
                <li key={e.id}><span className={`badge ${e.kind === 'external_action' ? 's-waiting' : ''}`}>{e.kind === 'external_action' ? `done outside: ${e.key}` : 'evidence'}</span><span className="grow wraps">{e.text}</span><Who id={e.author} /><time>{clock(e.ts)}</time></li>
              ))}
            </ul>
            {live && (
              <div className="composer slim">
                <input value={proof} onChange={(e) => setProof(e.target.value)} placeholder="A commit, a test run, a link" maxLength={5000} />
                <button disabled={proof.trim() === ''} onClick={() => void act(() => api.call('add_evidence', { task: t.id, text: proof })).then((ok) => ok && setProof(''))}><Icon name="clip" />Attach</button>
              </div>
            )}

            <h4>Properties</h4>
            <dl className="props">
              <dt>Created by</dt><dd><Who id={t.creator} /></dd>
              <dt>Project</dt><dd><ProjectField t={t} /></dd>
              {t.participants && <><dt>Participants</dt><dd className="stack">{(t.participants as string).split(' ').map((p) => <Who key={p} id={p} />)}</dd></>}
              <dt>Review</dt><dd>{t.review}</dd>
              <dt>Visible to</dt><dd>{t.private === 1 ? 'its parties only' : 'everyone'}</dd>
              {d.cost > 0 && <><dt>Cost</dt><dd>{usd(d.cost)}</dd></>}
              <dt>Revision</dt><dd>{t.rev}</dd>
              <dt>Created</dt><dd>{ago(t.created, now)}</dd>
              <dt>Updated</dt><dd>{ago(t.updated, now)}</dd>
            </dl>

            {live && t.status !== 'in_review' && (
              <>
                <h4>Hand to</h4>
                <div className="row">
                  <Assignee value={to} onChange={setTo} none="Choose…" />
                  <button disabled={to === '' || to === t.assignee} onClick={() => void act(() => api.call('delegate_task', { task: t.id, to, rev: t.rev })).then((ok) => ok && setTo(''))}>Hand over</button>
                  {t.assignee !== '' && <button onClick={run('release_task', { rev: t.rev })}>Unassign</button>}
                </div>
              </>
            )}
            {live && (
              <>
                <h4>Mark done</h4>
                <textarea value={result} {...imageHandlers(result, setResult, act)} onChange={(e) => setResult(e.target.value)} rows={2} placeholder="What came of it and what shows it" maxLength={20000} />
                <div className="row end"><button className="primary" disabled={result.trim() === ''} onClick={() => void act(() => api.call('complete_task', { task: t.id, result, rev: t.rev })).then((ok) => ok && setResult(''))}><Icon name="check" />Mark done</button></div>
              </>
            )}
            {decided.length > 0 && (
              <>
                <h4>Past reviews</h4>
                {decided.map((r) => <div key={r.id} className="past"><span className="row"><Badge status={r.status} /><Who id={r.decider} /></span><p className="muted">{r.comment || r.note}</p></div>)}
              </>
            )}
          </div>
        )}

        {tab === 'activity' && (
          <ul className="timeline">
            {events.length === 0 && <li className="muted">Nothing recorded yet.</li>}
            {events.map((e) => <li key={e.seq}><Avatar id={e.actor} size={20} /><span className="grow">{e.summary}</span><time>{when(e.ts, now)}</time></li>)}
          </ul>
        )}
      </div>
      {tab === 'discussion' && (
        <div className="reply">
          <Icon name="comment" className="muted" />
          <MentionInput value={comment} onChange={setComment} onSend={() => void say()} placeholder="Reply or @mention an agent…" ariaLabel={`Comment on ${t.id}`} />
          <button className="primary icon send" onClick={() => void say()} disabled={comment.trim() === ''} aria-label="Send"><Icon name="send" /></button>
        </div>
      )}
      {sub && <NewTask parent={t.id} onClose={() => setSub(false)} />}
    </>,
  );
}

/** A task's project, changed in place by whoever may change the task. */
function ProjectField({ t }: { t: Row }) {
  const { act, me } = useCtx();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState((t.project as string | undefined) ?? '');
  const may = me.role !== 'viewer' && (me.kind === 'user' || t.creator === me.id || t.assignee === me.id) && (me.kind === 'user' || (t.status !== 'done' && t.status !== 'cancelled'));
  if (!editing) return <span className="row">{t.project ? <span className="tag project-tag"><ProjectMark name={t.project as string} size={14} />{t.project}</span> : <span className="muted">none</span>}{may && <button className="ghost small" onClick={() => { setValue((t.project as string | undefined) ?? ''); setEditing(true); }}>Change</button>}</span>;
  const save = async (): Promise<void> => {
    const next = value.trim();
    if (next === ((t.project as string | undefined) ?? '')) { setEditing(false); return; }
    if (await act(() => api.call('update_task', { task: t.id, rev: t.rev, project: next === '' ? 'none' : next }))) setEditing(false);
  };
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <ProjectInput value={value} onChange={setValue} autoFocus />
      <button className="primary small" type="submit">Save</button>
      <button className="ghost small" type="button" onClick={() => setEditing(false)}>Cancel</button>
    </form>
  );
}
