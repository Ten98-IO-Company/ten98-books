import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  blankDraft, canTakeStored, classifyAnswer, createDraftController, isLocked, lockAlert, refusal, startMachine, step, storedDraftsOf, storedOf,
  type DraftAction, type DraftMachine, type DraftState, type SendFailure, type StoredDraft,
} from '../src/lib/voucher-entry/index.ts';

// The draft machine and its controller (docs/VOUCHERS.md, "The draft, its key and its lock").

const blank = (): DraftState => blankDraft('payment', 'single', '2026-01-01');
const filled = (narration = 'rent'): DraftState => ({ ...blank(), account: 'l-bank', narration });
const editing = (draft = filled()): DraftMachine => startMachine('key-1', draft);
const sending = (from: DraftMachine = editing()): DraftMachine => step(from, { type: 'accept', body: 'body-1' });
const answered = (machine: DraftMachine, answer: 'refused' | 'conflict' | 'signed-out' | 'limited' | 'none') => step(machine, { type: 'answered', answer, message: answer });
const kept = (phase: StoredDraft['phase'], key = 'key-kept', draft = filled('kept')): StoredDraft =>
  ({ phase, key, draft, sent: phase === 'editing' ? null : 'body-kept', message: phase === 'editing' ? null : 'lost', savedAt: '2026-01-01T10:00:00.000Z' });

/** Every change a caller can ask of the draft. */
const everyAction: DraftAction[] = [
  { type: 'date', date: '2026-01-02' }, { type: 'account', ledger: 'l-other' }, { type: 'lines', lines: [] }, { type: 'narration', text: 'changed' },
  { type: 'bills', row: 'line-1', rows: [] }, { type: 'relaid', relaid: { kind: 'receipt', layout: 'double', account: '', lines: [] } },
];

test('the answer classes: 2xx saved, 409 idempotency_mismatch conflict, a coded 4xx refused, 401 and 429 apart, anything else no answer', () => {
  assert.equal(classifyAnswer({ ok: true }), 'saved');
  const of = (status: number | undefined, code?: string) => classifyAnswer({ ok: false, status, code });
  assert.equal(of(409, 'idempotency_mismatch'), 'conflict');
  for (const [status, code] of [[400, 'validation'], [409, 'stale_revision'], [422, 'locked_period'], [403, 'retry'], [404, 'not_found']] as const) assert.equal(of(status, code), 'refused', `${status} ${code}`);
  assert.equal(of(401), 'signed-out');
  assert.equal(of(401, 'validation'), 'signed-out');
  assert.equal(of(429), 'limited');
  for (const status of [undefined, 0, 500, 502, 503, 504]) assert.equal(of(status), 'none', String(status));
  assert.equal(of(404), 'none', 'a 4xx without a ledger code is not the server\'s answer (a proxy\'s page)');
  assert.equal(of(409), 'none', 'a 409 without its code says nothing about the key');
});

test('the transition table: one key from creation to a save or a discard', () => {
  const start = editing();
  const sent = sending(start);
  assert.deepEqual([sent.phase, sent.key, sent.sent, sent.resume], ['sending', 'key-1', 'body-1', 'editing'], 'accept freezes the body, the key unchanged');
  assert.equal(step(sent, { type: 'accept', body: 'body-2' }), sent, 'a second accept is dropped');
  const saved = step(sent, { type: 'saved', nextKey: 'key-2' });
  assert.deepEqual([saved.phase, saved.key, saved.draft.narration, saved.draft.account, saved.sent], ['editing', 'key-2', '', '', null], 'saved: a new draft with a new key');
  const refused = answered(sent, 'refused');
  assert.deepEqual([refused.phase, refused.key, refusal(refused), lockAlert(refused)], ['editing', 'key-1', 'refused', null], 'refused: editing, the key kept, the message shown');
  const edited = step(refused, { type: 'edit', action: { type: 'narration', text: 'fixed' } });
  assert.deepEqual([edited.key, refusal(edited)], ['key-1', null], 'an edit answers the refusal and keeps the key');
  assert.equal(sending(edited).key, 'key-1', 'refused, edited, sent again: the same key');
  const conflict = answered(sent, 'conflict');
  assert.deepEqual([conflict.phase, conflict.key, conflict.sent, lockAlert(conflict)?.phase], ['conflict', 'key-1', 'body-1', 'conflict'], 'a 409 mismatch is a conflict, never a refusal');
  const unknown = answered(sent, 'none');
  assert.deepEqual([unknown.phase, unknown.key, unknown.sent, lockAlert(unknown)?.phase], ['unknown', 'key-1', 'body-1', 'unknown']);
  const retried = step(unknown, { type: 'retry' });
  assert.deepEqual([retried.phase, retried.key, retried.sent, retried.resume, lockAlert(retried)], ['sending', 'key-1', 'body-1', 'unknown', null], 'check and retry: the same key and body');
  for (const answer of ['signed-out', 'limited'] as const) {
    const back = answered(retried, answer);
    assert.deepEqual([back.phase, back.key, back.sent, lockAlert(back)?.message], ['unknown', 'key-1', 'body-1', 'none'], `${answer} during a retry: unknown, and the alert stays`);
    const fromEditing = answered(sent, answer);
    assert.deepEqual([fromEditing.phase, fromEditing.key, fromEditing.sent, refusal(fromEditing)], ['editing', 'key-1', null, answer], `${answer} from editing: editing again`);
  }
  for (const answer of ['refused', 'conflict'] as const) assert.notEqual(answered(retried, answer).phase, 'unknown', `${answer} leaves unknown`);
  assert.equal(step(retried, { type: 'saved', nextKey: 'key-9' }).key, 'key-9');
  for (const answer of ['refused', 'conflict', 'none', 'signed-out', 'limited'] as const) assert.equal(answered(start, answer), start, 'an answer with nothing in flight changes nothing');
  assert.equal(step(start, { type: 'saved', nextKey: 'key-x' }), start);
  assert.equal(step(start, { type: 'retry' }), start, 'retry only from unknown');
  for (const from of [start, unknown, conflict]) {
    const discarded = step(from, { type: 'discard', nextKey: 'key-new', draft: blank() });
    assert.deepEqual([discarded.phase, discarded.key, isLocked(discarded)], ['editing', 'key-new', false], `discard from ${from.phase}`);
  }
  assert.equal(step(sent, { type: 'discard', nextKey: 'key-new', draft: blank() }), sent, 'nothing is discarded while its answer is on the way');
});

test('the machine itself refuses every change in sending, unknown and conflict: edits, checks, accepts, restore and drop', () => {
  const offered = [kept('unknown')];
  const start = startMachine('key-1', filled(), offered);
  const locked = [sending(start), answered(sending(start), 'none'), answered(sending(start), 'conflict')];
  for (const machine of locked) {
    assert.equal(isLocked(machine), true, machine.phase);
    for (const action of everyAction) assert.equal(step(machine, { type: 'edit', action }), machine, `${machine.phase}: ${action.type}`);
    for (const event of [{ type: 'problem', message: 'x' }, { type: 'accept', body: 'other' }, { type: 'restore' }, { type: 'drop' }] as const) {
      assert.equal(step(machine, event), machine, `${machine.phase}: ${event.type}`);
    }
  }
  assert.equal(isLocked(start), false);
  for (const action of everyAction) assert.notEqual(step(start, { type: 'edit', action }), start, `editing: ${action.type} passes`);
});

test('a kept draft comes back exactly as it was, and only into an empty editing draft', () => {
  const unknown = kept('unknown');
  const machine = startMachine('key-new', blank(), [unknown, kept('editing', 'key-second')]);
  assert.equal(canTakeStored(machine), true);
  const restored = step(machine, { type: 'restore' });
  assert.deepEqual([restored.phase, restored.key, restored.sent, restored.draft, lockAlert(restored)?.phase], ['unknown', 'key-kept', 'body-kept', unknown.draft, 'unknown'], 'an unknown draft comes back locked, with its own key and body');
  assert.deepEqual(restored.offered.map(entry => entry.key), ['key-second'], 'the next kept draft is offered');
  assert.equal(step(restored, { type: 'restore' }), restored, 'not over a locked draft (H1)');
  const typing = step(machine, { type: 'edit', action: { type: 'narration', text: 'a new one' } });
  assert.equal(canTakeStored(typing), false);
  assert.equal(step(typing, { type: 'restore' }), typing, 'not over a draft with something entered');
  assert.equal(step(typing, { type: 'drop' }), typing);
  const dropped = step(machine, { type: 'drop' });
  assert.deepEqual([dropped.key, dropped.offered.map(entry => entry.key)], ['key-new', ['key-second']]);
  // Kept for a lost session: the whole state; a save under a kept key stops offering it.
  const inUnknown = answered(sending(editing()), 'none');
  assert.deepEqual(storedOf(inUnknown, 'now'), { phase: 'unknown', key: 'key-1', draft: filled(), sent: 'body-1', message: 'none', savedAt: 'now' });
  assert.equal(storedOf(answered(sending(editing()), 'signed-out'), 'now').message, null, 'an editing draft is kept without the message of its lost session');
  const savedKept = step(sending(startMachine('key-kept', filled(), [unknown])), { type: 'saved', nextKey: 'key-2' });
  assert.deepEqual(savedKept.offered, [], 'the voucher saved under a kept key is no longer offered');
});

test('kept drafts are read back only when every field checks; an unsettled one keeps its body', () => {
  const entries = [kept('editing'), kept('unknown', 'key-u'), kept('conflict', 'key-c')];
  assert.deepEqual(storedDraftsOf(JSON.stringify(entries)), entries);
  const withBills = { ...kept('editing'), draft: { ...filled(), bills: { 'line-1': [{ key: 'b1', method: 'new_ref', bill: '', name: 'A1', credit: '30', amount: '5.00', side: 'Dr' }] } } };
  assert.deepEqual(storedDraftsOf(JSON.stringify([withBills])), [withBills]);
  const broken: unknown[] = [
    { ...kept('unknown'), sent: null }, { ...kept('editing'), phase: 'sending' }, { ...kept('editing'), key: '' }, { ...kept('editing'), savedAt: 5 },
    { ...kept('editing'), draft: { ...filled(), kind: 'sales' } }, { ...kept('editing'), draft: { ...filled(), layout: 'triple' } },
    { ...kept('editing'), draft: { ...filled(), kind: 'journal', layout: 'single' } }, { ...kept('editing'), draft: { ...filled(), serial: 1.5 } },
    { ...kept('editing'), draft: { ...filled(), lines: [{ key: 'l', side: 'Debit', ledger: '', amount: '' }] } },
    { ...kept('editing'), draft: { ...filled(), lines: [{ key: 'l', side: 'Dr', ledger: 5, amount: '' }] } },
    { ...kept('editing'), draft: { ...filled(), narration: null } }, { ...kept('editing'), draft: { ...filled(), bills: [] } },
    { ...kept('editing'), draft: { ...filled(), bills: { 'line-1': [{ key: 'b', method: 'gift', bill: '', name: '', credit: '', amount: '', side: '' }] } } },
    { ...kept('editing'), draft: { ...filled(), bills: { 'line-1': [{ key: 'b', method: '', bill: '', name: '', credit: '', side: '' }] } } },
  ];
  for (const entry of broken) assert.deepEqual(storedDraftsOf(JSON.stringify([entry])), [], JSON.stringify(entry).slice(0, 120));
  for (const text of [null, '', 'not json', '{}', JSON.stringify(kept('editing'))]) assert.deepEqual(storedDraftsOf(text), [], String(text));
});

// ---- The controller (what the screen's hook runs), driven against a fake server ----

/** A failure as the api helper throws it: a status and the server's code. */
const failure = (status: number | undefined, code?: string) => Object.assign(new Error(`status ${status}`), { status, code });
const failureOf = (error: unknown): SendFailure => ({
  status: error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : undefined,
  code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined,
  message: error instanceof Error ? error.message : 'no answer',
});
const memoryStore = (text: string | null = null) => ({ text, read() { return this.text; }, write(value: string) { this.text = value; } });

test('the controller: one request at a time, a 401 keeps the whole state, restore gives it back, retry is a replay', async () => {
  const store = memoryStore();
  let keys = 0;
  const bodies: string[] = [];
  let answer: () => Promise<string> = async () => 'ok';
  let signedOut = 0;
  const make = () => createDraftController<string>({ start: blank(), makeKey: () => `key-${++keys}`, store, send: body => { bodies.push(body); return answer(); }, failureOf, now: () => 'at', onSignedOut: () => { signedOut++; } });
  const first = make();
  first.edit({ type: 'narration', text: 'rent' });
  let release = (_: string) => {};
  answer = () => new Promise(resolve => { release = resolve; });
  const pending = first.save('body-rent');
  assert.ok(pending);
  assert.equal(first.save('body-rent'), null, 'a double press is dropped');
  assert.equal(first.edit({ type: 'narration', text: 'meddle' }), false, 'nothing changes while sending');
  let settled = false;
  const waiting = first.settled().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'a question asked while sending waits for the answer');
  assert.equal(bodies.length, 1);
  answer = async () => { throw failure(502); };
  release('late');
  assert.equal((await pending)?.kind, 'saved');
  await waiting;
  assert.deepEqual([settled, first.machine().phase], [true, 'editing'], 'and then sees the saved voucher');
  await first.settled();
  assert.equal(first.machine().key, 'key-2');
  first.edit({ type: 'narration', text: 'wages' });
  assert.equal((await first.save('body-wages'))?.kind, 'none');
  assert.equal(first.machine().phase, 'unknown');
  answer = async () => { throw failure(401); };
  assert.equal((await first.retry())?.kind, 'signed-out');
  assert.equal(first.machine().phase, 'unknown', 'M1: the alert stays after a 401 during a retry');
  assert.deepEqual(storedDraftsOf(store.read()).map(entry => [entry.phase, entry.key, entry.sent]), [['unknown', 'key-2', 'body-wages']]);
  assert.equal(signedOut, 1);
  // Signed in again: a new screen, offered the kept draft.
  const second = make();
  assert.equal(second.machine().offered.length, 1);
  assert.equal(second.restore(), true);
  assert.deepEqual([second.machine().phase, second.machine().key], ['unknown', 'key-2'], 'restored locked, under its own key');
  assert.equal(store.read(), '', 'taken out of the store');
  answer = async () => 'replayed';
  assert.equal((await second.retry())?.kind, 'saved');
  assert.deepEqual(bodies.slice(-2), ['body-wages', 'body-wages'], 'the retry sends exactly the body sent before');
  assert.equal(signedOut, 1);
});

// ---- The model test: random sequences against a fake server with exactly the server's three facts ----

/** A small fast generator with a fixed seed, so a failure names its sequence. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)] };
}

type Mode = 'commit' | 'commit-lose' | 'lose-before' | 'server-error' | 'refuse' | 'signed-out' | 'limited';
// Weighted towards commits and lost sessions, so two tabs holding one kept draft (the way to a conflict) come up often.
const modes: readonly Mode[] = ['commit', 'commit', 'commit-lose', 'lose-before', 'server-error', 'refuse', 'signed-out', 'signed-out', 'limited'];

/**
 * The server's three facts and nothing more: a commit stores the key with the body's hash; the same key and body is a
 * replay; the same key with another body is 409 `idempotency_mismatch`. It can be told to lose the answer before or after
 * committing, refuse, or not run the request (401, 429).
 */
class FakeServer {
  keys = new Map<string, string>();
  commits: { key: string; intention: number }[] = [];
  requests = 0;
  mode: Mode = 'commit';
  served: 'saved' | 'refused' | 'conflict' | 'signed-out' | 'limited' | 'none' = 'none';
  async send(body: string, intention: number): Promise<string> {
    this.requests++;
    const parsed: unknown = JSON.parse(body);
    assert.ok(typeof parsed === 'object' && parsed !== null && 'key' in parsed && 'content' in parsed);
    const { key, content } = parsed;
    assert.ok(typeof key === 'string' && typeof content === 'string');
    const fail = (served: FakeServer['served'], status: number | undefined, code?: string) => { this.served = served; return failure(status, code); };
    if (this.mode === 'lose-before') throw fail('none', undefined);
    if (this.mode === 'server-error') throw fail('none', 503);
    if (this.mode === 'signed-out') throw fail('signed-out', 401);
    if (this.mode === 'limited') throw fail('limited', 429);
    const prior = this.keys.get(key);
    if (prior !== undefined && prior !== content) throw fail('conflict', 409, 'idempotency_mismatch');
    if (prior === undefined) {
      if (this.mode === 'refuse') throw fail('refused', 400, 'validation');
      this.keys.set(key, content);
      this.commits.push({ key, intention });
    }
    if (this.mode === 'commit-lose') throw fail('none', undefined);
    this.served = 'saved';
    return 'ok';
  }
}

type Tab = {
  store: ReturnType<typeof memoryStore>;
  controller: ReturnType<typeof createDraftController<string>>;
  /** The user's intention the draft on screen belongs to: new on a save, a discard or a fresh screen. */
  intention: number;
  /** What the alert must be, from the answers the server gave (the model's own reading, not the machine's). */
  expect: 'unknown' | 'conflict' | null;
  signedOut: boolean;
};

async function runModel(seed: number, sequences: number, maxLength: number): Promise<{ steps: number; reached: Set<string> }> {
  const rng = random(seed);
  let steps = 0;
  // The cases the sequences reached, so a weak generator shows.
  const reached = new Set<string>();
  for (let sequence = 0; sequence < sequences; sequence++) {
    const server = new FakeServer();
    let intentions = 0;
    let keys = 0;
    // What each kept draft was when kept, by its key: its intention and the alert it must come back with.
    // (Per tab store: a duplicated tab copies the store, and what it holds, at that moment.)
    const keptAs = new Map<Tab['store'], Map<string, { intention: number; expect: Tab['expect'] }>>();
    const keptIn = (store: Tab['store']) => { const found = keptAs.get(store) ?? new Map(); keptAs.set(store, found); return found; };
    const mount = (store: ReturnType<typeof memoryStore>): Tab => {
      const user: Omit<Tab, 'controller'> = { store, intention: ++intentions, expect: null, signedOut: false };
      const controller = createDraftController<string>({ start: blank(), makeKey: () => `k${sequence}-${++keys}`, store, send: body => server.send(body, user.intention), failureOf, now: () => 'at' });
      return Object.assign(user, { controller });
    };
    const tabs: Tab[] = [mount(memoryStore())];
    const length = 1 + Math.floor(rng.next() * maxLength);
    const where = (event: string) => `seed ${seed}, sequence ${sequence}, step ${steps}: ${event}`;
    for (let index = 0; index < length; index++, steps++) {
      const tab = rng.pick(tabs);
      const before = tab.controller.machine();
      const body = () => { const m = tab.controller.machine(); return JSON.stringify({ key: m.key, content: JSON.stringify(m.draft) }); };
      // A kept draft on offer is taken up or carried into a second tab more often: two tabs holding one kept draft is the way to a conflict.
      let event: string = canTakeStored(before) && rng.next() < 0.4 ? rng.pick(['restore', 'restore', 'duplicate-tab']) : rng.pick(['edit', 'edit', 'accept', 'accept', 'double-accept', 'retry', 'retry', 'restore', 'restore', 'restore', 'drop', 'leave-confirm', 'leave-cancel', 'start-new', 'duplicate-tab', 'duplicate-tab', 'problem']);
      if (tab.signedOut) event = 'sign-in';
      let served: FakeServer['served'] | null = null;
      let keyChangeAllowed = false;
      const send = async (pending: Promise<unknown> | null) => {
        if (!pending) return;
        const from = tab.expect;
        await pending;
        served = server.served;
        if (served === 'saved') { tab.intention = ++intentions; tab.expect = null; keyChangeAllowed = true; }
        else if (served === 'refused') tab.expect = null;
        else if (served === 'conflict') tab.expect = 'conflict';
        else if (served === 'none') tab.expect = 'unknown';
        else {
          tab.expect = from;
          if (served === 'signed-out') { tab.signedOut = true; keptIn(tab.store).set(tab.controller.machine().key, { intention: tab.intention, expect: tab.expect }); }
        }
      };
      switch (event) {
        case 'edit': tab.controller.edit(rng.pick<DraftAction>([{ type: 'narration', text: rng.pick(['', 'a', 'b']) }, { type: 'account', ledger: rng.pick(['', 'l-1', 'l-2']) }])); break;
        case 'problem': tab.controller.problem('check'); break;
        case 'accept': server.mode = rng.pick(modes); await send(tab.controller.save(body())); break;
        case 'retry': server.mode = rng.pick(modes); await send(tab.controller.retry()); break;
        case 'double-accept': {
          server.mode = rng.pick(modes);
          const requests = server.requests;
          const pending = before.phase === 'unknown' ? tab.controller.retry() : tab.controller.save(body());
          if (pending) {
            const frozen = tab.controller.machine();
            assert.equal(frozen.phase, 'sending', where('a send starts sending'));
            // Everything a user can do while the request is in flight: all refused (I2), and still one request.
            assert.equal(tab.controller.save(body()), null, where('I2: a second accept is dropped'));
            assert.equal(tab.controller.retry(), null, where('I2: no retry while sending'));
            for (const action of everyAction) tab.controller.edit(action);
            tab.controller.problem('x'); tab.controller.restore(); tab.controller.drop(); tab.controller.discard(blank());
            assert.equal(tab.controller.machine(), frozen, where('I2: nothing changes while sending'));
            assert.equal(server.requests, requests + 1, where('one request'));
          }
          await send(pending);
          break;
        }
        case 'restore': {
          const offered = before.offered[0];
          if (tab.controller.restore() && offered) {
            const was = keptIn(tab.store).get(offered.key);
            assert.ok(was, where('a kept draft was kept by the model'));
            tab.intention = was.intention; tab.expect = was.expect; keyChangeAllowed = true;
            assert.equal(tab.controller.machine().key, offered.key, where('I3: a restore brings the kept draft\'s own key'));
          }
          break;
        }
        case 'drop': tab.controller.drop(); break;
        case 'start-new': if (tab.controller.discard(blank())) { tab.intention = ++intentions; tab.expect = null; keyChangeAllowed = true; } break;
        // Leaving (after the question) or signing in again is a new screen on the same tab's store.
        case 'leave-confirm': case 'sign-in': tabs[tabs.indexOf(tab)] = mount(tab.store); continue;
        case 'leave-cancel': break;
        case 'duplicate-tab': if (tabs.length < 2) { const copy = memoryStore(tab.store.read()); keptAs.set(copy, new Map(keptIn(tab.store))); tabs.push(mount(copy)); } break;
      }
      const after = tab.controller.machine();
      reached.add(`${before.phase} ${event}${served ? ` ${served}` : ''} ${after.phase}`);
      if (event === 'restore' && after !== before) reached.add(`restored ${after.phase}`);
      // I1: one intention, at most one voucher.
      const perIntention = new Map<number, number>();
      for (const commit of server.commits) perIntention.set(commit.intention, (perIntention.get(commit.intention) ?? 0) + 1);
      for (const [intention, count] of perIntention) assert.ok(count <= 1, where(`I1: intention ${intention} has ${count} vouchers`));
      // I2: in sending, unknown and conflict the content and the key never change.
      if (before.phase !== 'editing' && after.phase !== 'editing' && event !== 'restore') {
        assert.deepEqual([after.key, after.draft], [before.key, before.draft], where(`I2: ${before.phase} to ${after.phase} changed the draft or key (${event})`));
      }
      // I3: the key changes only on a save, a discard, or a restore (to the kept draft's own key).
      if (after.key !== before.key) assert.ok(keyChangeAllowed, where(`I3: the key changed on ${event} (${served ?? 'no answer'})`));
      // I4: the alert is shown exactly in unknown and conflict, as the server's answers say it must be.
      assert.equal(lockAlert(after)?.phase ?? null, tab.expect, where(`I4: alert ${lockAlert(after)?.phase ?? 'none'}, expected ${tab.expect ?? 'none'} after ${event} (${served ?? 'no answer'})`));
      // I5: from unknown a definite answer leaves unknown; a lost session and a limit never do.
      if (before.phase === 'unknown' && served !== null) {
        if (served === 'saved' || served === 'refused' || served === 'conflict') assert.notEqual(after.phase, 'unknown', where(`I5: ${served} left the draft unknown`));
        else assert.equal(after.phase, 'unknown', where(`I5: ${served} left unknown`));
      }
    }
  }
  return { steps, reached };
}

const modelSeed = 20261115;
const modelSequences = 5000;

test(`the model: ${modelSequences} random sequences of up to 40 steps, seed ${modelSeed}, keep I1 to I5`, async () => {
  const started = performance.now();
  const { steps, reached } = await runModel(modelSeed, modelSequences, 40);
  assert.ok(steps > modelSequences * 15);
  for (const wanted of ['restored unknown', 'restored editing', 'unknown retry signed-out unknown', 'unknown retry limited unknown', 'unknown retry saved editing',
    'unknown retry refused editing', 'editing accept conflict conflict', 'unknown double-accept signed-out unknown', 'editing accept none unknown', 'conflict start-new editing', 'unknown start-new editing']) {
    assert.ok(reached.has(wanted), `the sequences reach: ${wanted}`);
  }
  console.log(`model: seed ${modelSeed}, ${modelSequences} sequences, ${steps} steps, ${Math.round(performance.now() - started)} ms`);
});
