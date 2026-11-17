import { act } from 'react';
import { create } from 'react-test-renderer';
import { expect, test } from 'bun:test';
import { Prose } from '../ui/prose';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
async function render(text: string) {
  let tree: ReturnType<typeof create> | undefined;
  await act(async () => { tree = create(<Prose>{text}</Prose>); });
  return tree!;
}
test('renders Markdown and code as safe elements, not raw HTML', async () => {
  const tree = await render('# Title\n\n```ts\nconst answer = 42 // clear\n```\n\n[safe](https://example.com)\n\n<script>alert(1)</script>');
  expect(tree.root.findByType('h1').children).toEqual(['Title']);
  expect(tree.root.findByType('pre').findByType('code').props.className).toBe('language-ts');
  expect(tree.root.findAll((n) => n.props.className === 'syntax-keyword').map(n => n.children.join(''))).toContain('const');
  expect(tree.root.findAll((n) => n.props.className === 'syntax-number').map(n => n.children.join(''))).toContain('42');
  expect(tree.root.findByType('a').props).toMatchObject({ href: 'https://example.com', target: '_blank', rel: 'noreferrer noopener nofollow' });
  expect(tree.root.findAllByType('script')).toHaveLength(0);
  expect(JSON.stringify(tree.toJSON())).toContain('<script>alert(1)</script>');
});
test('images are links the reader may open, never fetched by the page; refused links are plain text', async () => {
  const tree = await render('![tracker](http://10.0.0.1/pixel.png) [bad](javascript:alert(1)) [ok](https://example.com)');
  expect(tree.root.findAllByType('img')).toHaveLength(0);
  const links = tree.root.findAllByType('a');
  expect(links.map((a) => a.props.href)).toEqual(['http://10.0.0.1/pixel.png', 'https://example.com']);
  expect(links[0]!.children).toEqual(['tracker']);
  expect(JSON.stringify(tree.toJSON())).toContain('bad');
});
test('inline code remains compact; GFM tables remain structured', async () => {
  const tree = await render('Use `inbox(through)`.\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  expect(tree.root.findByType('code').props.className).toBeUndefined();
  expect(tree.root.findByType('table')).toBeDefined();
  expect(tree.root.findAllByType('td')).toHaveLength(2);
});

test('@ offers a participant picker at the caret, not inside an email', async () => {
  const { mentionAt } = await import('../ui/mention');
  expect(mentionAt('hello @', 7)).toEqual({ start: 6, query: '' });
  expect(mentionAt('hello @mo', 9)).toEqual({ start: 6, query: 'mo' });
  expect(mentionAt('a@b.com', 4)).toBeNull();
  expect(mentionAt('@@', 2)).toBeNull();
  expect(mentionAt('@alice finished', 6)).toEqual({ start: 0, query: 'alice' });
  expect(mentionAt('@alice finished', 15)).toBeNull();
});
