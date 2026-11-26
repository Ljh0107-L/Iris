import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../app/main/session-manager.mjs';

test('a session saved without an engine is an Iris session; the stored record is not modified', t => {
  const plain = { id: 'plain', model: { provider: 'model_hub', id: 'very-long-model-name' } };
  const codex = { id: 'codex', engine: 'codex' };
  const manager = new SessionManager({ store: { sessions: [plain, codex], settings: {} }, environments: () => [], local: {} });
  t.after(() => clearInterval(manager.sweeper));
  assert.deepEqual(manager.list().map(s => s.engine), ['iris', 'codex']);
  assert.equal(Object.hasOwn(plain, 'engine'), false);
});
