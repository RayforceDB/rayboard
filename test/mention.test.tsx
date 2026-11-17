import { act } from 'react';
import { create } from 'react-test-renderer';
import { expect, test } from 'bun:test';
import { MentionInput } from '../ui/mention';
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
