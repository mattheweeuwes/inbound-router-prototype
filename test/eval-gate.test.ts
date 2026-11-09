// The eval gate and the freeze manifest: floors, fail-closed preflight, classifier source set and hashes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config';
import {
  FLOORS, RULES_FLOORS, GATE_N, classifierFiles, combinedHash, compareClassifier, evaluateGate, gatePreflight, rulesGatePreflight, gateTable, infraFailures, ollamaTemperature, sha256, type SetCounts,
} from '../scripts/lib/eval-gate';

const sets = (sealed: [number, number, number], heldout: [number, number, number]): SetCounts[] => {
  const mk = (name: string, [u, c, d]: [number, number, number]): SetCounts => ({ name, n: GATE_N, v4: { urgency: { ok: u, n: GATE_N }, useCase: { ok: c, n: GATE_N }, disqualifier: { ok: d, n: GATE_N } } });
  return [mk('dev', [0, 0, 0]), mk('heldout', heldout), mk('sealed', sealed)];
};

describe('eval gate floors', () => {
  it('the floors are the ones the claim is defended with', () => {
    assert.deepEqual(FLOORS.sealed, { urgency: 22, useCase: 17, disqualifier: 21 });
    assert.deepEqual(FLOORS.heldout, { urgency: 21, useCase: 19, disqualifier: 22 });
  });
  it('passes at the recorded results and exactly at the floors', () => {
    assert.equal(evaluateGate(sets([23, 18, 22], [22, 20, 23])).pass, true);
    assert.equal(evaluateGate(sets([22, 17, 21], [21, 19, 22])).pass, true);
  });
  it('fails when any single field is one below its floor', () => {
    const base = { sealed: [22, 17, 21], heldout: [21, 19, 22] } as const;
    for (const set of ['sealed', 'heldout'] as const) {
      for (let i = 0; i < 3; i++) {
        const s = { sealed: [...base.sealed] as [number, number, number], heldout: [...base.heldout] as [number, number, number] };
        s[set][i] -= 1;
        const g = evaluateGate(sets(s.sealed, s.heldout));
        assert.equal(g.pass, false, `${set}[${i}]`);
        assert.equal(g.rows.filter(r => !r.pass).length, 1);
      }
    }
  });
  it('fails (never skips) when a gated set is missing or scored on a different number of items', () => {
    assert.equal(evaluateGate(sets([24, 24, 24], [24, 24, 24]).filter(s => s.name !== 'sealed')).pass, false);
    const odd = sets([24, 24, 24], [24, 24, 24]); odd[2].v4.urgency = { ok: 23, n: 23 };
    const g = evaluateGate(odd);
    assert.equal(g.pass, false);
    assert.match(g.rows.find(r => !r.pass)!.why, /23 items/);
  });
  it('prints floor versus actual per field', () => {
    const t = gateTable(evaluateGate(sets([23, 18, 22], [22, 20, 23])).rows);
    assert.match(t, /sealed\s+urgency\s+22\/24\s+23\/24\s+PASS/);
    assert.match(t, /heldout\s+disqualifier\s+22\/24\s+23\/24\s+PASS/);
    assert.equal(t.split('\n').length, 7);
  });
});

describe('eval gate fails closed', () => {
  const ok = { provider: 'ollama', modelReachable: true, sealedExists: true, model: 'llama3.2:3b', ollamaUrl: 'http://127.0.0.1:11434' };
  it('no problems when the model answers and the sealed set exists', () => assert.deepEqual(gatePreflight(ok), []));
  it('an unreachable model is a failure with a clear message', () => {
    const p = gatePreflight({ ...ok, modelReachable: false });
    assert.equal(p.length, 1);
    assert.match(p[0], /unreachable/);
    assert.match(p[0], /llama3\.2:3b/);
  });
  it('a rules-only provider cannot pass the gate', () => assert.equal(gatePreflight({ ...ok, provider: 'rules', modelReachable: false }).length, 1));
  it('a missing sealed set cannot pass the gate', () => assert.match(gatePreflight({ ...ok, sealedExists: false })[0], /sealed/));
  it('counts only unavailable and timed-out model calls as infrastructure failures', () => {
    assert.equal(infraFailures([null, 'llm_unavailable: Ollama unreachable: x', 'llm_timeout: Ollama call exceeded 8s', 'llm_invalid_output: bad', 'llm_low_confidence (0.50 < 0.6)']), 2);
  });
});

describe('freeze manifest', () => {
  const files = classifierFiles(ROOT);
  const paths = files.map(f => f.path);
  it('lists every file under src/qualify and what they import at runtime, sorted', () => {
    for (const f of ['combine', 'index', 'llm', 'prompt', 'rules', 'when']) assert.ok(paths.includes(`src/qualify/${f}.ts`), f);
    for (const f of ['src/schema.ts', 'src/time.ts']) assert.ok(paths.includes(f), f);
    assert.ok(!paths.includes('src/config.ts'), 'the hosted provider reads ctx.cfg, so the config loader is no longer classifier code');
    assert.deepEqual([...paths].sort(), paths);
    assert.ok(!paths.includes('src/context.ts'), 'type-only imports are not classifier code');
    assert.ok(files.every(f => /^[0-9a-f]{64}$/.test(f.sha256) && f.why));
  });
  it('each file hash is the sha256 of its bytes', () => {
    const f = files.find(x => x.path === 'src/qualify/when.ts')!;
    assert.equal(f.sha256, sha256(readFileSync(join(ROOT, f.path))));
  });
  it('the combined hash is stable, order-independent in its input, and changes when any one file changes', () => {
    const h = combinedHash(files);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(combinedHash([...files].reverse()), h);
    assert.equal(combinedHash(files), h);
    const edited = files.map((f, i) => (i === 0 ? { ...f, sha256: sha256('edited') } : f));
    assert.notEqual(combinedHash(edited), h);
    assert.notEqual(combinedHash(files.slice(1)), h, 'dropping a file changes it too');
  });
  it('compares the classifier hash with the recorded run in the two required words', () => {
    assert.equal(compareClassifier('a', 'a').message, 'classifier unchanged since the recorded run');
    assert.equal(compareClassifier('a', 'b').message, 'classifier CHANGED since the recorded run: sealed results now describe different code');
    assert.equal(compareClassifier('a', 'b').changed, true);
    assert.equal(compareClassifier('a', null).changed, null);
  });
  it('reads the temperature from the Ollama call, and it is 0', () => {
    assert.equal(ollamaTemperature(readFileSync(join(ROOT, 'src', 'qualify', 'llm.ts'), 'utf8')), 0);
    assert.equal(ollamaTemperature('nothing here'), null);
  });
});

describe('rules-only eval gate', () => {
  const ok = { provider: 'rules', sealedExists: true };
  const rulesSets = (sealed: [number, number, number], heldout: [number, number, number]) => sets(sealed, heldout);
  it('preflight passes with provider rules and the sealed set', () => assert.deepEqual(rulesGatePreflight(ok), []));
  it('preflight fails for any other provider, ollama included (a model run is not deterministic)', () => {
    for (const provider of ['ollama', 'anthropic', '']) {
      const p = rulesGatePreflight({ ...ok, provider });
      assert.equal(p.length, 1, provider);
      assert.match(p[0], /not "rules"/);
    }
  });
  it('preflight fails without the sealed set', () => {
    const p = rulesGatePreflight({ ...ok, sealedExists: false });
    assert.equal(p.length, 1);
    assert.match(p[0], /sealed/);
  });
  it('needs no model: an unreachable model is not a rules-gate problem', () => assert.deepEqual(rulesGatePreflight({ provider: 'rules', sealedExists: true }), []));
  it('the model gate preflight still rejects the rules provider, and its floors are unchanged', () => {
    const p = gatePreflight({ provider: 'rules', modelReachable: false, sealedExists: true, model: 'm', ollamaUrl: 'u' });
    assert.equal(p.length, 1);
    assert.match(p[0], /not "ollama"/);
    assert.deepEqual(FLOORS.sealed, { urgency: 22, useCase: 17, disqualifier: 21 });
  });
  it('the rules floors are the measured results of 2026-11-08, with no slack', () => {
    assert.deepEqual(RULES_FLOORS.sealed, { urgency: 23, useCase: 13, disqualifier: 20 });
    assert.deepEqual(RULES_FLOORS.heldout, { urgency: 22, useCase: 18, disqualifier: 23 });
  });
  it('passes exactly at the rules floors and fails one below on any field', () => {
    const base = { sealed: [23, 13, 20], heldout: [22, 18, 23] } as const;
    assert.equal(evaluateGate(rulesSets([...base.sealed], [...base.heldout]), RULES_FLOORS).pass, true);
    for (const set of ['sealed', 'heldout'] as const) {
      for (let i = 0; i < 3; i++) {
        const s = { sealed: [...base.sealed] as [number, number, number], heldout: [...base.heldout] as [number, number, number] };
        s[set][i] -= 1;
        const g = evaluateGate(rulesSets(s.sealed, s.heldout), RULES_FLOORS);
        assert.equal(g.pass, false, `${set}[${i}]`);
        assert.equal(g.rows.filter(r => !r.pass).length, 1);
      }
    }
  });
  it('rows carry the rules floors, not the model floors', () => {
    const g = evaluateGate(rulesSets([23, 13, 20], [22, 18, 23]), RULES_FLOORS);
    assert.equal(g.rows.find(r => r.set === 'sealed' && r.field === 'useCase')!.floor, 13);
    assert.match(gateTable(g.rows), /sealed\s+useCase\s+13\/24\s+13\/24\s+PASS/);
    // the model gate's floors would fail these same results (sealed use case 17), which is why the two floor sets are separate
    assert.equal(evaluateGate(rulesSets([23, 13, 20], [22, 18, 23])).pass, false);
  });
  it('still fails (never skips) when a gated set is missing', () => {
    assert.equal(evaluateGate(rulesSets([24, 24, 24], [24, 24, 24]).filter(s => s.name !== 'sealed'), RULES_FLOORS).pass, false);
  });
});
