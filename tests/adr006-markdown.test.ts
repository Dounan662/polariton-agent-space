import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RootContent } from 'mdast';
import { parseGfmWithMath } from '../web/src/ui/markdown/parse.ts';
import { IncrementalMarkdownParser } from '../web/src/ui/markdown/incremental.ts';

/** Compare semantic output; parser positions are relative to each incremental slice. */
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'position').map(([key, child]) => [key, semantic(child)]));
  return value;
}
function stream(text: string) {
  const parser = new IncrementalMarkdownParser(parseGfmWithMath);
  let nodes: RootContent[] = [];
  for (let end = 1; end <= text.length; end++) {
    const result = parser.update(text.slice(0, end));
    nodes = [...result.frozen, ...result.tail].map(block => block.node);
  }
  assert.deepEqual(semantic(nodes), semantic(parseGfmWithMath(text).children));
  return nodes;
}

test('streaming completed inline and display formulas preserve the settled native math grammar', () => {
  const text = 'Intro\n\nInline $x^2$ and \\(y+1\\).\n\n$$\n\\begin{matrix}1&2\\\\3&4\\end{matrix}\n$$\n\nAfter\n\nFinal';
  const nodes = stream(text);
  assert.ok(nodes.some(node => node.type === 'math'));
  assert.match(JSON.stringify(nodes), /inlineMath/);
});

test('an incomplete streaming code fence retains every content line and becomes a complete math fence', () => {
  const prefix = 'Before\n\n```math\nx^2 +\ny^2';
  const open = stream(prefix).find(node => node.type === 'code');
  assert.equal(open?.type === 'code' && open.value, 'x^2 +\ny^2');
  const complete = stream(prefix + '\n```\n\nAfter').find(node => node.type === 'code');
  assert.equal(complete?.type === 'code' && complete.lang, 'math');
  assert.equal(complete?.type === 'code' && complete.value, 'x^2 +\ny^2');
});

test('incomplete delimiters and malformed TeX remain lossless parser input without throwing', () => {
  for (const text of ['Unfinished \\(x +', '$$\n\\frac{1}{', 'Bad $\\unknown{broken$ then text', 'Literal price \\$5']) stream(text);
  assert.equal(parseGfmWithMath('Bad $\\unknown{broken$ then text').children[0]?.type, 'paragraph');
});

test('native local-image recovery accepts bare path spaces without rewriting code or escaped examples',()=>{
 const image='![Plot](/workspace/research images/plot.png)';
 const parsed=parseGfmWithMath(image).children[0];
 assert.equal(parsed?.type,'paragraph');
 assert.equal(parsed?.type==='paragraph'&&parsed.children[0]?.type,'image');
 for(const literal of ['`'+image+'`','\\'+image,'![File](/workspace/research files/data.txt)']) {
  assert.equal(JSON.stringify(parseGfmWithMath(literal)).includes('"type":"image"'),false);
 }
 stream(image+'\n\nAfter the plot');
});
