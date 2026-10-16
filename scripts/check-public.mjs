import {readFile, readdir, stat} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fromMarkdown} from 'mdast-util-from-markdown';

// Inspect the distributable source without starting services or visiting links.
// Local generated directories, root Trunk state and Finder metadata are outside
// that source. Symlinks are still rejected before exclusions; secret files elsewhere
// fail by name before their contents are read. This is not a complete secret audit.
const root = fileURLToPath(new URL('../', import.meta.url));
const generated = new Set(['node_modules', '.local', '.cache', '.npm-cache', 'dist', 'build', 'coverage', 'test-results', 'playwright-report', '.git']);
const problems = [];
let checked = 0;
const markdown = [];
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{32,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
];
async function walk(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name), name = relative(root, path);
    if (entry.isSymbolicLink()) { problems.push(`${name}: source symlink`); continue; }
    if (entry.isDirectory()) {
      if (!generated.has(entry.name) && name !== '.trunk') await walk(path);
      continue;
    }
    if (!entry.isFile()) { problems.push(`${name}: nonregular source file`); continue; }
    if (entry.name === '.DS_Store') continue;
    if (/^\.env(?:\.|$)/.test(entry.name) && !entry.name.endsWith('.example') || /^(?:\.credentials\.ya?ml|credentials\.env|\.npmrc)$/.test(entry.name)) {
      problems.push(`${name}: private or machine-local file`); continue;
    }
    checked++;
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8');
    if (secretPatterns.some(pattern => pattern.test(text))) problems.push(`${name}: possible credential; inspect privately`);
    if (/\/Users\/[^/\s]+\//.test(text)) problems.push(`${name}: private machine path`);
    if (entry.name.endsWith('.md')) markdown.push({path, text});
  }
}
await walk(root);
for (const {path, text} of markdown) {
  const visit = async node => {
    if (['link', 'image', 'definition'].includes(node.type)) {
      const url = node.url;
      if (url && !/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(url)) {
        const target = resolve(dirname(path), decodeURIComponent(url.split(/[?#]/)[0]));
        const name = relative(root, target);
        if (name === '..' || name.startsWith('..' + sep)) problems.push(`${relative(root, path)}: link leaves repository: ${url}`);
        else {
          try { await stat(target); }
          catch (error) { if (error.code !== 'ENOENT') throw error; problems.push(`${relative(root, path)}: missing link: ${url}`); }
        }
      }
    }
    for (const child of node.children ?? []) await visit(child);
  };
  await visit(fromMarkdown(text));
}
if (problems.length) throw new Error(problems.join('\n'));
console.log(`Public source checks passed: ${checked} files; ${markdown.length} Markdown documents. External URLs and heading anchors are not checked.`);
