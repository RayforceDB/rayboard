import { act } from 'react';
import { create } from 'react-test-renderer';
import { expect, test } from 'bun:test';
import { completionAt, MentionInput } from '../ui/mention';
import { BoardContext, type Ctx } from '../ui/kit';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const board = { now: new Date().toISOString(), agents: [{ id: 'a_mica', name: 'mica', kind: 'teneral', status: 'active' }, { id: 'a_morsel', name: 'morsel', kind: 'teneral', status: 'active' }, { id: 'a_old', name: 'old', status: 'revoked' }], people: [{ id: 'u_anton', name: 'anton', kind: 'user', role: 'admin', status: 'active' }], channels: [], tasks: [], reviews: [], dms: [], threads: [], enrollment: false, seq: 1 };
const ctx = { board, tick: 0, me: board.people[0], name: (id: string) => id, act: async () => true, open: () => {}, unread: () => false, markRead: () => {} } as unknown as Ctx;

test('mention picker filters, chooses with the keyboard, and replaces only the active token', async () => {
  let value = 'hello @m';
  let sent = 0;
  let bubbled = false;
  let tree: ReturnType<typeof create>;
  (globalThis as { requestAnimationFrame?: (f: () => void) => number }).requestAnimationFrame = (f) => { f(); return 0; };
  await act(async () => { tree = create(<BoardContext.Provider value={ctx}><MentionInput value={value} onChange={(v) => { value = v; }} onSend={() => { sent++; }} placeholder="message" /></BoardContext.Provider>); });
  const input = tree!.root.findByType('textarea');
  await act(async () => { input.props.onChange({ target: { value: 'hello @m', selectionStart: 8 } }); });
  expect(tree!.root.findAllByProps({ role: 'option' }).map((o) => o.findAllByType('span')[0]!.children.join(''))).toEqual(['@mica', '@morsel']);
  await act(async () => { input.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} }); });
  await act(async () => { input.props.onKeyDown({ key: 'Enter', preventDefault() {} }); });
  expect(value).toBe('hello @morsel ');
  expect(sent).toBe(0);
  await act(async () => { input.props.onChange({ target: { value: 'hello @m', selectionStart: 8 } }); });
  await act(async () => { input.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() { bubbled = true; } }); });
  expect(bubbled).toBe(true);
  expect(tree!.root.findAllByProps({ role: 'option' })).toHaveLength(0);
  // The picker lists only participants from the authorized snapshot, including the person typing.
  await act(async () => { input.props.onChange({ target: { value: 'hello @m', selectionStart: 8 } }); });
  await act(async () => { input.props.onSelect({ currentTarget: { selectionStart: 6 } }); });
  await act(async () => { input.props.onChange({ target: { value: 'hello @', selectionStart: 7 } }); });
  expect(tree!.root.findAllByProps({ role: 'option' }).map((o) => o.props.id)).toHaveLength(3);
  await act(async () => { tree!.unmount(); });
});

test('@ lists only active identities, while # lists channels and preserves the marker', async () => {
  const local = { ...ctx, board: { ...board, channels: [{ id: 'c_general', name: 'general' }, { id: 'c_private', name: 'private' }] } } as unknown as Ctx;
  let value = '';
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<BoardContext.Provider value={local}><MentionInput value={value} onChange={(v) => { value = v; }} onSend={() => {}} placeholder="message" /></BoardContext.Provider>); });
  const input = tree!.root.findByType('textarea');
  await act(async () => { input.props.onChange({ target: { value: 'see #g', selectionStart: 7 } }); });
  await act(async()=>{tree!.update(<BoardContext.Provider value={local}><MentionInput value={'see #g'} onChange={(v) => { value = v; }} onSend={() => {}} placeholder="message" /></BoardContext.Provider>);});
  expect(tree!.root.findAllByProps({ role: 'option' }).map((o) => o.findAllByType('span')[1]!.children.join(''))).toEqual(['#general']);
  await act(async () => { input.props.onKeyDown({ key: 'Enter', preventDefault() {} }); });
  expect(value).toBe('see #general ');
  await act(async () => { input.props.onChange({ target: { value: '@', selectionStart: 1 } }); });
  await act(async()=>{tree!.update(<BoardContext.Provider value={local}><MentionInput value={'@'} onChange={(v) => { value = v; }} onSend={() => {}} placeholder="message" /></BoardContext.Provider>);});
  const labels = tree!.root.findAllByProps({ role: 'option' }).map((o) => o.findAllByType('span').at(-1)!.children.join(''));
  expect(labels).toContain('@all'); expect(labels).toContain('@mica'); expect(labels).not.toContain('#general'); expect(labels).not.toContain('@old');
  await act(async () => { tree!.unmount(); });
});

test('a controlled value edit refreshes a stale caret for channel completion', async () => {
  const local = { ...ctx, board: { ...board, channels: [{ id: 'c_general', name: 'general' }] } } as unknown as Ctx;
  let tree: ReturnType<typeof create>;
  const view = (v: string) => <BoardContext.Provider value={local}><MentionInput value={v} onChange={() => {}} onSend={() => {}} placeholder="message" /></BoardContext.Provider>;
  await act(async () => { tree = create(view('')); });
  await act(async () => { tree!.update(view('show #general')); });
  expect(tree!.root.findAllByProps({ role: 'option' })).toHaveLength(1);
  await act(async () => { tree!.unmount(); });
});

test('# after / or & stays part of a link or an entity, while # after a space is a channel', () => {
  for (const text of ['https://host/#gen', 'a&#12', 'C#', 'page#sec']) expect(completionAt(text, text.length)).toBeNull();
  expect(completionAt('see #gen', 8)).toEqual({ start: 4, query: 'gen', kind: 'channel' });
  expect(completionAt('#gen', 4)).toEqual({ start: 0, query: 'gen', kind: 'channel' });
});

test('Ctrl or Cmd+Enter sends even while the picker is open', async () => {
  const local = { ...ctx, board: { ...board, channels: [{ id: 'c_general', name: 'general' }] } } as unknown as Ctx;
  let value = 'see #gen';
  let sent = 0;
  let tree: ReturnType<typeof create>;
  const view = (v: string) => <BoardContext.Provider value={local}><MentionInput value={v} onChange={(next) => { value = next; }} onSend={() => { sent++; }} placeholder="message" /></BoardContext.Provider>;
  await act(async () => { tree = create(view(value)); });
  const input = tree!.root.findByType('textarea');
  await act(async () => { input.props.onChange({ target: { value: 'see #gen', selectionStart: 8 } }); });
  await act(async () => { tree!.update(view('see #gen')); });
  expect(tree!.root.findAllByProps({ role: 'option' })).toHaveLength(1);
  await act(async () => { input.props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {} }); });
  await act(async () => { input.props.onKeyDown({ key: 'Enter', metaKey: true, preventDefault() {} }); });
  expect(sent).toBe(2);
  expect(value).toBe('see #gen');
  await act(async () => { tree!.unmount(); });
});
