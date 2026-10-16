import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResearchTree} from '../src/research.ts';
import {loadConfig} from '../src/config.ts';
import type {Mutation} from '../src/contracts.ts';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'adr012-research-')));
  const config = {...await loadConfig(), stateRoot: root, cliPageSize: 2};
  let sequence = 0;
  const id = () => `12100000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  let tree = new ResearchTree(config); await tree.initialize();
  const project = await tree.createProject(id(), 'Retained research');
  t.after(async () => { await tree.close(); await rm(root, {recursive: true, force: true}); });
  return {project: project.id, id, get tree() { return tree; },
    async change(command: Mutation['command']) {
      const mutation = {operationId: id(), revision: tree.graph(project.id).revision, command};
      await tree.mutate(project.id, mutation); return mutation;
    },
    async reopen() { await tree.close(); tree = new ResearchTree(config); await tree.initialize(); },
  };
}

test('public graph history retains relation edits, retraction and archival with stable sequence pagination', async t => {
  const f = await fixture(t), first = f.id(), second = f.id(), relation = f.id();
  const mutations: Mutation[] = [];
  for (const node of [first, second]) mutations.push(await f.change({kind: 'node.create', id: node, title: node === first ? 'Source' : 'Follow-up', description: ''}));
  mutations.push(await f.change({kind: 'edge.create', id: relation, from: first, to: second, relation: 'Questions', explanation: 'Initial interpretation'}));
  mutations.push(await f.change({kind: 'edge.edit', id: relation, relation: 'Revises', explanation: 'Updated interpretation'}));
  mutations.push(await f.change({kind: 'edge.retract', id: relation}));
  mutations.push(await f.change({kind: 'node.archive', id: first, archived: true}));
  const collect = () => {
    let after = 0;
    const records: ReturnType<ResearchTree['history']>['entries'] = [];
    do {
      const page = f.tree.history(f.project, after);
      assert.equal(page.revision, mutations.length);
      assert.equal(page.recovery, null);
      assert(page.entries.length <= 2);
      records.push(...page.entries);
      if (page.next === null) break;
      assert(page.next > after, 'Every nonterminal page must advance the public cursor');
      after = page.next;
    } while (true);
    return records;
  };
  const expected = mutations.map(mutation => ({...mutation, seq: mutation.revision + 1}));
  assert.deepEqual(collect(), expected);
  await f.tree.mutate(f.project, mutations[2]!);
  assert.deepEqual(collect(), expected, 'Duplicate operation must not add another retained edit');
  await f.reopen();
  assert.deepEqual(collect(), expected);
  assert.equal(f.tree.graph(f.project).edges[0]!.retracted, true);
  assert.deepEqual(f.tree.history(f.project, mutations.length).entries, []);
});

test('graph history rejects invalid cursor and page bounds without changing authoritative state', async t => {
  const f = await fixture(t);
  await f.change({kind: 'node.create', id: f.id(), title: 'Action', description: ''});
  const before = f.tree.graph(f.project);
  for (const [after, limit] of [[-1, 1], [0.5, 1], [2, 1], [0, 0], [0, 3], [0, 1.5]]) {
    assert.throws(() => f.tree.history(f.project, after, limit), {code: 'INVALID_CURSOR'});
  }
  assert.deepEqual(f.tree.graph(f.project), before);
  assert.deepEqual(f.tree.history(f.project, 0, 1).entries.map(entry => entry.seq), [1]);
});
