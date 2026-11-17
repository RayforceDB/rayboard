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
test('inline code remains compact; GFM tables remain structured', async () => {
  const tree = await render('Use `inbox(through)`.\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  expect(tree.root.findByType('code').props.className).toBeUndefined();
  expect(tree.root.findByType('table')).toBeDefined();
  expect(tree.root.findAllByType('td')).toHaveLength(2);
});
