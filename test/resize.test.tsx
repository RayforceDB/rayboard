import { act } from 'react';
import { create } from 'react-test-renderer';
import { expect, test } from 'bun:test';
import { panelWidth, ResizeHandle } from '../ui/resize';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const values = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, clear: () => values.clear(), key: () => null, removeItem: k => values.delete(k), length: 0 } as Storage;

test('panel widths are clamped and a keyboard separator persists them', async () => {
  expect(panelWidth('sidebar', 236, 180, 360)).toBe(236);
  values.set('rayboard.panel.sidebar.v1', '9999');
  expect(panelWidth('sidebar', 236, 180, 360)).toBe(360);
  let value = 236;
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ResizeHandle name="sidebar" value={value} setValue={v => { value = v; }} min={180} max={360} />); });
  const handle = tree!.root.findByProps({ role: 'separator' });
  expect(handle.props['aria-valuenow']).toBe(236);
  await act(async () => { handle.props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, shiftKey: true }); });
  expect(value).toBe(276);
  expect(values.get('rayboard.panel.sidebar.v1')).toBe('276');
  await act(async () => { handle.props.onKeyDown({ key: 'End', preventDefault() {} }); });
  expect(value).toBe(360);
  await act(async () => { tree!.unmount(); });
});

test('pointer drag follows the correct edge and releases capture', async () => {
  let value = 400; let captured = false; let released = false;
  let tree: ReturnType<typeof create>;
  await act(async () => { tree = create(<ResizeHandle name="task" value={value} setValue={v => { value = v; }} min={320} max={720} reverse />); });
  const handle = tree!.root.findByProps({ role: 'separator' });
  await act(async () => { handle.props.onPointerDown({ button: 0, pointerId: 1, clientX: 900, preventDefault() {}, currentTarget: { setPointerCapture() { captured = true; } } }); });
  await act(async () => { tree!.update(<ResizeHandle name="task" value={value} setValue={v => { value = v; }} min={320} max={720} reverse />); });
  await act(async () => { handle.props.onPointerMove({ pointerId: 1, clientX: 850 }); });
  expect(value).toBe(450);
  await act(async () => { handle.props.onPointerUp({ pointerId: 1, currentTarget: { hasPointerCapture: () => true, releasePointerCapture() { released = true; } } }); });
  await act(async () => { handle.props.onPointerMove({ pointerId: 1, clientX: 500 }); });
  expect(value).toBe(450);
  expect(captured && released).toBe(true);
  await act(async () => { tree!.unmount(); });
});

test('task and conversation handles use the keys their panels read', async () => {
  for (const [label, storage, start] of ([['task panel', 'task', 400], ['conversation list', 'conversations', 220]] as [string, string, number][])) {
    let value = start;
    let tree: ReturnType<typeof create>;
    await act(async () => { tree = create(<ResizeHandle name={label} storageName={storage} value={value} setValue={v => { value = v; }} min={180} max={720} />); });
    const handle = tree!.root.findByProps({ role: 'separator' });
    await act(async () => { handle.props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, shiftKey: false }); });
    expect(values.get(`rayboard.panel.${storage}.v1`)).toBe(String(start + 12));
    expect(panelWidth(storage, start, 180, 720)).toBe(start + 12);
    await act(async () => { tree!.unmount(); });
  }
});
