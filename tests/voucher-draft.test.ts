import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  answerNeverArrived, askBeforeLeaving, blankDraft, canTakeStored, classifyAnswer, createDraftController, dropKeptDraft, dropQuestion, isLocked, leaveQuestion,
  lockAlert, refusal, startMachine, startNewVoucher, step, storedDraftsOf, storedOf,
  type AnswerClass, type DraftAction, type DraftMachine, type DraftState, type Question, type SendFailure, type StoredDraft,
} from '../src/lib/voucher-entry/index.ts';

// The draft machine, its controller and the screen's questions (docs/VOUCHERS.md, "The draft, its key and its lock").

const blank = (): DraftState => blankDraft('payment', 'single', '2026-01-01');
const filled = (narration = 'rent'): DraftState => ({ ...blank(), account: 'l-bank', narration });
const editing = (draft = filled()): DraftMachine => startMachine('key-1', draft);
const sending = (from: DraftMachine = editing()): DraftMachine => step(from, { type: 'accept', body: 'body-1' });
const answered = (machine: DraftMachine, answer: Exclude<AnswerClass, 'saved'>) => step(machine, { type: 'answered', answer, message: answer });
const kept = (phase: StoredDraft['phase'], key = 'key-kept', draft = filled('kept')): StoredDraft =>
  ({ phase, key, draft, sent: phase === 'editing' ? null : 'body-kept', message: phase === 'editing' ? null : 'lost', savedAt: '2026-01-01T10:00:00.000Z' });

/** Every change a caller can ask of the draft. */
const everyAction: DraftAction[] = [
  { type: 'date', date: '2026-01-02' }, { type: 'account', ledger: 'l-other' }, { type: 'lines', lines: [] }, { type: 'narration', text: 'changed' },
  { type: 'bills', row: 'line-1', rows: [] }, { type: 'relaid', relaid: { kind: 'receipt', layout: 'double', account: '', lines: [] } },
];

test('the answer classes: the full table of docs/VOUCHERS.md', () => {
  assert.equal(classifyAnswer({ ok: true }), 'saved');
  const of = (status: number | undefined, json: boolean, code?: string) => classifyAnswer({ ok: false, status, code, json });
  const table: [number | undefined, boolean, string | undefined, AnswerClass][] = [
    [401, true, undefined, 'signed-out'], [401, false, undefined, 'signed-out'], [401, true, 'validation', 'signed-out'],
    [429, true, undefined, 'limited'], [429, false, undefined, 'limited'],
    [409, true, 'idempotency_mismatch', 'conflict'],
    // Checked before the replay: origin, role, membership, a route.
    [403, true, undefined, 'denied'], [403, true, 'forbidden', 'denied'], [404, true, 'not_found', 'denied'], [404, true, undefined, 'denied'],
    // The request ran and rolled back, coded or not.
    [400, true, 'validation', 'refused'], [409, true, 'stale_revision', 'refused'], [409, true, undefined, 'refused'], [422, true, 'locked_period', 'refused'],
    [405, true, undefined, 'refused'], [413, true, undefined, 'refused'], [415, true, undefined, 'refused'],
    // Not the application's answer, or none.
    [404, false, undefined, 'none'], [403, false, undefined, 'none'], [409, false, undefined, 'none'],
    [500, true, undefined, 'none'], [502, false, undefined, 'none'], [503, false, undefined, 'none'], [504, false, undefined, 'none'],
    [undefined, false, undefined, 'none'], [0, false, undefined, 'none'], [200, false, undefined, 'none'],
  ];
  for (const [status, json, code, expected] of table) assert.equal(of(status, json, code), expected, `${status} ${json ? 'json' : 'other'} ${code ?? ''}`);
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
  for (const answer of ['signed-out', 'limited', 'denied'] as const) {
    const back = answered(retried, answer);
    assert.deepEqual([back.phase, back.key, back.sent, lockAlert(back)?.message, lockAlert(back)?.note], ['unknown', 'key-1', 'body-1', 'none', answer], `${answer} during a retry: unknown, the alert stays, its answer noted`);
    const fromEditing = answered(sent, answer);
    assert.deepEqual([fromEditing.phase, fromEditing.key, fromEditing.sent, refusal(fromEditing)], ['editing', 'key-1', null, answer], `${answer} from editing: editable again, shown`);
  }
  for (const answer of ['refused', 'conflict'] as const) assert.notEqual(answered(retried, answer).phase, 'unknown', `${answer} leaves unknown`);
  assert.equal(answered(step(answered(retried, 'denied'), { type: 'retry' }), 'none').note, null, 'a note lasts only until the next answer');
  assert.equal(step(retried, { type: 'saved', nextKey: 'key-9' }).key, 'key-9');
  for (const answer of ['refused', 'denied', 'conflict', 'none', 'signed-out', 'limited'] as const) assert.equal(answered(start, answer), start, 'an answer with nothing in flight changes nothing');
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
  assert.equal(step(restored, { type: 'restore' }), restored, 'not over a locked draft');
  const typing = step(machine, { type: 'edit', action: { type: 'narration', text: 'a new one' } });
  assert.equal(canTakeStored(typing), false);
  assert.equal(step(typing, { type: 'restore' }), typing, 'not over a draft with something entered');
  assert.equal(step(typing, { type: 'drop' }), typing);
  const dropped = step(machine, { type: 'drop' });
  assert.deepEqual([dropped.key, dropped.offered.map(entry => entry.key)], ['key-new', ['key-second']]);
  const inUnknown = answered(sending(editing()), 'none');
  assert.deepEqual(storedOf(inUnknown, 'now'), { phase: 'unknown', key: 'key-1', draft: filled(), sent: 'body-1', message: 'none', savedAt: 'now' });
  assert.deepEqual(storedOf(sending(editing()), 'now'), { phase: 'unknown', key: 'key-1', draft: filled(), sent: 'body-1', message: answerNeverArrived, savedAt: 'now' }, 'a sending draft is kept as unknown: its answer never arrived here');
  assert.equal(storedOf(answered(sending(editing()), 'signed-out'), 'now').message, null, 'an editing draft is kept without the message of its lost session');
  const savedKept = step(sending(startMachine('key-kept', filled(), [unknown])), { type: 'saved', nextKey: 'key-2' });
  assert.deepEqual(savedKept.offered, [], 'the voucher saved under a kept key is no longer offered');
});

test('kept drafts are read back only when every field checks; an unsettled one keeps its body', () => {
  const entries = [kept('editing'), kept('unknown', 'key-u'), kept('conflict', 'key-c'), { ...kept('editing', 'key-s'), phase: 'saved' as const, message: 'saved as No. 3' }];
  assert.deepEqual(storedDraftsOf(JSON.stringify(entries)), entries);
  const withBills = { ...kept('editing'), draft: { ...filled(), bills: { 'line-1': [{ key: 'b1', method: 'new_ref', bill: '', name: 'A1', credit: '30', amount: '5.00', side: 'Dr' }] } } };
  assert.deepEqual(storedDraftsOf(JSON.stringify([withBills])), [withBills]);
  const broken: unknown[] = [
    { ...kept('unknown'), sent: null }, { ...kept('editing'), phase: 'sending' }, { ...kept('editing'), phase: 'saved', message: null }, { ...kept('editing'), key: '' }, { ...kept('editing'), savedAt: 5 },
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

/** A failure as the api helper throws it: a status, the server's code and whether it was the application's JSON. */
const failure = (status: number | undefined, code?: string, json = status !== undefined && status < 500) => Object.assign(new Error(`status ${status}`), { status, code, json });
const failureOf = (error: unknown): SendFailure => ({
  status: error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : undefined,
  code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined,
  message: error instanceof Error ? error.message : 'no answer',
  json: error instanceof Error && 'json' in error && error.json === true,
});
const memoryStore = (text: string | null = null) => ({ text, read() { return this.text; }, write(value: string) { this.text = value; } });
const keptIn = (store: { read: () => string | null }) => storedDraftsOf(store.read()).map(entry => [entry.phase, entry.key]);

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
  assert.deepEqual(keptIn(store), [['unknown', 'key-1']], 'kept the moment it is sent');
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
  assert.deepEqual(keptIn(store), [], 'a saved voucher is no longer kept');
  assert.equal(first.machine().key, 'key-2');
  first.edit({ type: 'narration', text: 'wages' });
  assert.equal((await first.save('body-wages'))?.kind, 'none');
  assert.equal(first.machine().phase, 'unknown');
  answer = async () => { throw failure(401); };
  assert.equal((await first.retry())?.kind, 'signed-out');
  assert.equal(first.machine().phase, 'unknown', 'the alert stays after a 401 during a retry');
  assert.deepEqual(storedDraftsOf(store.read()).map(entry => [entry.phase, entry.key, entry.sent]), [['unknown', 'key-2', 'body-wages']]);
  assert.equal(signedOut, 1);
  const second = make();
  assert.equal(second.machine().offered.length, 1);
  assert.equal(second.restore(), true);
  assert.deepEqual([second.machine().phase, second.machine().key], ['unknown', 'key-2'], 'restored locked, under its own key');
  assert.deepEqual(keptIn(store), [['unknown', 'key-2']], 'still kept while it is unknown on screen');
  answer = async () => 'replayed';
  assert.equal((await second.retry())?.kind, 'saved');
  assert.deepEqual(bodies.slice(-2), ['body-wages', 'body-wages'], 'the retry sends exactly the body sent before');
  assert.deepEqual(keptIn(store), []);
});

test('M-B: a 4xx that is not the application\'s own error (a proxy\'s JSON) is no answer: the voucher stays unknown and kept', async () => {
  const store = memoryStore();
  for (const status of [403, 404, 409, 400]) {
    const controller = createDraftController<string>({ start: blank(), makeKey: () => `key-${status}`, store, failureOf, now: () => 'at', send: async () => { throw failure(status, undefined, false); } });
    controller.edit({ type: 'narration', text: String(status) });
    assert.equal((await controller.save('body'))?.kind, 'none', String(status));
    assert.equal(controller.machine().phase, 'unknown');
  }
  assert.deepEqual(keptIn(store).map(([phase]) => phase), ['unknown', 'unknown', 'unknown', 'unknown'], 'all kept');
});

test('M1: a voucher sending, unknown or in conflict is in the tab from the moment it gets there, and leaving, reloading or a late answer never forgets it', async () => {
  const store = memoryStore();
  let keys = 0;
  const releases: ((outcome: Error | string) => void)[] = [];
  const make = () => createDraftController<string>({
    start: blank(), makeKey: () => `key-${++keys}`, store, failureOf, now: () => 'at', savedAs: answer => `saved as ${answer}`,
    send: () => new Promise((resolve, reject) => { releases.push(outcome => outcome instanceof Error ? reject(outcome) : resolve(outcome)); }),
  });
  // Unknown, then a new screen on the same store (a reload): offered as unknown.
  const first = make();
  first.edit({ type: 'narration', text: 'a' });
  const sent = first.save('body-a');
  releases.shift()?.(failure(502));
  await sent;
  assert.deepEqual(keptIn(store), [['unknown', 'key-1']]);
  const reloaded = make();
  assert.deepEqual(reloaded.machine().offered.map(entry => [entry.phase, entry.key]), [['unknown', 'key-1']], 'unknown, reload: offered as unknown');
  // Sending, then left: offered as unknown, with what can be proved.
  reloaded.drop();
  assert.deepEqual(keptIn(store), []);
  const leaving = make();
  leaving.edit({ type: 'narration', text: 'b' });
  const inFlight = leaving.save('body-b');
  const leftKey = leaving.machine().key;
  const after = make();
  const offered = after.machine().offered[0];
  assert.deepEqual([offered?.phase, offered?.key, offered?.message], ['unknown', leftKey, answerNeverArrived], 'left while sending: kept as unknown');
  // The answer arrives after the user left: the screen is no longer shown, so it takes nothing out of the tab (a newer
  // screen may have restored the draft); restoring and retrying it then finds it saved. A newer screen's draft is untouched.
  leaving.onScreen(false);
  after.edit({ type: 'narration', text: 'c' });
  const newer = after.save('body-c');
  releases.shift()?.('saved behind the user');
  await inFlight;
  assert.deepEqual(keptIn(store), [['unknown', after.machine().key], ['saved', leftKey]], 'a late answer to a left screen takes nothing out: it rewrites its own entry as saved (LOW 1)');
  assert.equal(storedDraftsOf(store.read()).find(entry => entry.key === leftKey)?.message, 'saved as saved behind the user');
  // The notice is dismissed, never restored.
  const notice = make();
  store.write(JSON.stringify(storedDraftsOf(store.read()).filter(entry => entry.key === leftKey)));
  const withNotice = createDraftController<string>({ start: blank(), makeKey: () => 'n', store, failureOf, send: async () => 'x' });
  assert.equal(withNotice.restore(), false, 'a saved notice is not restored');
  assert.equal(withNotice.drop(), true, 'it is dismissed');
  assert.deepEqual(keptIn(store), []);
  void notice;
  store.write(JSON.stringify([{ ...storedOf(after.machine(), 'at') }]));
  releases.shift()?.(failure(409, 'idempotency_mismatch'));
  await newer;
  assert.deepEqual(keptIn(store), [['conflict', after.machine().key]], 'a conflict is kept too');
  assert.equal(after.discard(blank()), true);
  assert.deepEqual(keptIn(store), [], 'a confirmed discard takes it out');
  // Refused: editable again, not kept; an editable kept draft restored is taken out.
  const refusedScreen = make();
  refusedScreen.edit({ type: 'narration', text: 'd' });
  const refusedSave = refusedScreen.save('body-d');
  releases.shift()?.(failure(400, 'validation'));
  await refusedSave;
  assert.deepEqual(keptIn(store), [], 'a refusal is definite: not kept');
  store.write(JSON.stringify([kept('editing', 'key-typed')]));
  const restoring = make();
  assert.equal(restoring.restore(), true);
  assert.deepEqual(keptIn(store), [], 'restored as editable: taken out');
});

// ---- The questions ----

test('the questions: by the state, never about a Check and retry that is not there, and asked before work is lost', async () => {
  const unknown = answered(sending(), 'none');
  const conflict = answered(sending(), 'conflict');
  assert.equal(leaveQuestion(startMachine('k', blank()), false, 'Leave'), null, 'nothing entered: no question');
  assert.match(leaveQuestion(startMachine('k', blank()), true, 'Leave')?.title ?? '', /unsaved/, 'typed text counts');
  assert.match(leaveQuestion(editing(), false, 'Leave')?.title ?? '', /unsaved/);
  const whileSending = leaveQuestion(sending(), false, 'Leave');
  assert.match(whileSending?.title ?? '', /being saved/);
  assert.match(whileSending?.description ?? '', /kept in this tab/);
  assert.match(leaveQuestion(unknown, false, 'Leave')?.description ?? '', /kept in this tab under its key/);
  assert.doesNotMatch(leaveQuestion(unknown, false, 'Leave')?.description ?? '', /forgets/, 'leaving no longer forgets it');
  assert.match(leaveQuestion(conflict, false, 'Discard')?.description ?? '', /keeps nothing/);
  assert.match(dropQuestion(kept('unknown'))?.title ?? '', /may already be saved/);
  assert.ok(dropQuestion(kept('conflict')));
  assert.ok(dropQuestion(kept('editing')), 'typed work in a kept editing draft is asked about (LOW 7)');
  assert.equal(dropQuestion(kept('editing', 'k', blank())), null);
  // The actions ask first, and act only on a yes.
  const asked: Question[] = [];
  const answer = (yes: boolean) => async (question: Question) => { asked.push(question); return yes; };
  let discarded = 0, dropped = 0;
  assert.equal(await startNewVoucher(() => conflict, answer(false), () => { discarded++; return true; }, blank()), false);
  assert.deepEqual([asked.length, discarded], [1, 0], '"Start a new voucher" asks, and No keeps the voucher');
  assert.equal(await startNewVoucher(() => conflict, answer(true), () => { discarded++; return true; }, blank()), true);
  assert.equal(discarded, 1);
  const withKept = startMachine('k', blank(), [kept('unknown')]);
  assert.equal(await dropKeptDraft(() => withKept, answer(false), () => { dropped++; return true; }), false);
  assert.deepEqual([asked.length, dropped], [3, 0], 'a kept unknown draft is not dropped without asking');
  const withTyped = startMachine('k', blank(), [kept('editing')]);
  assert.equal(await dropKeptDraft(() => withTyped, answer(false), () => { dropped++; return true; }), false);
  assert.deepEqual([asked.length, dropped], [4, 0], 'nor a kept editing draft with typed work');
});

/** Fails instead of hanging when a promise does not settle in time (a question that never comes back). */
const within = <T,>(promise: Promise<T>, ms = 500): Promise<T> => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms))]);

test('M-A: the leave question never leaves without the user: a save answered meanwhile closes it and the screen stays, an unknown or conflict asks again', async () => {
  const outcomes: [string, (machine: DraftMachine) => DraftMachine, 'closed' | 'asked again'][] = [
    ['saved', machine => step(machine, { type: 'saved', nextKey: 'key-2' }), 'closed'],
    ['refused', machine => answered(machine, 'refused'), 'closed'],
    ['denied from editing', machine => answered(machine, 'denied'), 'closed'],
    ['unknown', machine => answered(machine, 'none'), 'asked again'],
    ['conflict', machine => answered(machine, 'conflict'), 'asked again'],
  ];
  for (const [name, answer, expected] of outcomes) {
    let machine = sending();
    let answerArrives = () => {};
    const settled = () => new Promise<void>(resolve => { answerArrives = resolve; });
    const asked: string[] = [];
    const answers: ((yes: boolean) => void)[] = [];
    let closed = 0;
    const ask = async (question: Question) => { asked.push(question.title); return new Promise<boolean>(resolve => { answers.push(resolve); }); };
    const leaving = askBeforeLeaving(() => machine, settled, () => false, ask, () => { closed++; });
    await Promise.resolve();
    assert.deepEqual(asked, ['Leave this payment while it is being saved?'], name);
    machine = answer(machine);
    answerArrives();
    if (expected === 'closed') {
      assert.equal(await within(leaving), false, `${name}: the screen stays`);
      assert.deepEqual([closed, asked.length], [1, 1], `${name}: the question closed, nothing asked again`);
    } else {
      await within(new Promise(resolve => setImmediate(resolve)));
      assert.deepEqual([closed, asked.length], [0, 2], `${name}: asked again for the new state`);
      assert.match(asked[1], name === 'unknown' ? /may already be saved/ : /was not saved/);
      answers[1](true);
      assert.equal(await within(leaving), true, `${name}: and the user's answer counts`);
    }
  }
  // With nothing in flight the question is asked once and its answer is the leave.
  const asked: string[] = [];
  assert.equal(await within(askBeforeLeaving(() => answered(sending(), 'none'), async () => {}, () => false, async question => { asked.push(question.title); return false; }, () => {})), false);
  assert.equal(asked.length, 1);
  assert.equal(await within(askBeforeLeaving(() => startMachine('k', blank()), async () => {}, () => false, async () => { throw new Error('asked'); }, () => {})), true, 'nothing entered: leaves without asking');
});

// ---- The model test: random sequences against a fake server with exactly the server's three facts ----

/** A small fast generator with a fixed seed, so a failure names its sequence. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, pick: <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)] };
}

/** What the server does with a request when it arrives (the session may override with a 401). */
type Mode = 'commit' | 'commit-lose' | 'lose-before' | 'server-error' | 'refuse' | 'limited' | 'denied';
const modes: readonly Mode[] = ['commit', 'commit', 'commit-lose', 'commit-lose', 'lose-before', 'server-error', 'refuse', 'limited', 'denied'];
type Served = AnswerClass;

/** A request in flight: it reaches the server (`arrived`) and its answer comes back (`delivered`) at separate steps. */
type Request = {
  key: string; content: string; intention: number; mode: Mode; fromUnknown: boolean;
  arrived: boolean; delivered: boolean; served: Served | null; result: Error | 'ok' | null;
  /** The screen that sent it is still the one on screen (null: left; the old screen still gets the answer). */
  owner: Tab | null;
  /** The page that sent it is gone (reload, closed tab): its answer never arrives anywhere. */
  orphan: boolean;
  /** The tab's store the sending screen writes to. */
  store: Tab['store'];
  settle: (outcome: Error | 'ok') => void;
  pending: Promise<unknown> | null;
};

/**
 * The server's three facts and nothing more: a commit stores the key with the body's hash; the same key and body is a
 * replay; the same key with another body is 409 `idempotency_mismatch`. Plus what does not reach the replay: a lost
 * session (401), a limit (429), a denial (403/404); and what may happen around it: an answer lost before or after the
 * commit, a server error.
 */
class FakeServer {
  keys = new Map<string, string>();
  commits: { key: string; intention: number }[] = [];
  sessionAlive = true;
  arrive(request: Request): void {
    request.arrived = true;
    const answer = (served: Served, result: Error | 'ok') => { request.served = served; request.result = result; };
    if (request.mode === 'lose-before') return answer('none', failure(undefined));
    if (request.mode === 'server-error') return answer('none', failure(503));
    if (!this.sessionAlive) return answer('signed-out', failure(401));
    if (request.mode === 'limited') return answer('limited', failure(429));
    if (request.mode === 'denied') return answer('denied', failure(404, 'not_found'));
    const prior = this.keys.get(request.key);
    if (prior !== undefined && prior !== request.content) return answer('conflict', failure(409, 'idempotency_mismatch'));
    if (prior === undefined) {
      if (request.mode === 'refuse') return answer('refused', failure(400, 'validation'));
      this.keys.set(request.key, request.content);
      this.commits.push({ key: request.key, intention: request.intention });
    }
    if (request.mode === 'commit-lose') return answer('none', failure(undefined));
    answer('saved', 'ok');
  }
}

type Tab = {
  store: ReturnType<typeof memoryStore>;
  controller: ReturnType<typeof createDraftController<string>>;
  /** The user's intention the draft on screen belongs to: new on a save, a discard or a fresh screen. */
  intention: number;
  /** The alert the answers so far say must show once nothing is in flight (the model's own reading, not the machine's). */
  outcome: 'unknown' | 'conflict' | null;
  request: Request | null;
  mustSignIn: boolean;
};

type Event = { kind: string; tab?: number; mode?: Mode };
/** Openings that set up the rare cases (two tabs on one kept draft, a denial on a retry, a late answer), so every seed reaches them. */
const openings: readonly Event[][] = [
  [{ kind: 'edit', tab: 0 }, { kind: 'accept', tab: 0, mode: 'commit-lose' }, { kind: 'deliver', tab: 0 }, { kind: 'leave', tab: 0 }, { kind: 'restore', tab: 0 }],
  [{ kind: 'edit', tab: 0 }, { kind: 'accept', tab: 0, mode: 'commit' }, { kind: 'leave', tab: 0 }, { kind: 'deliver-any' }, { kind: 'restore', tab: 0 }],
  [{ kind: 'edit', tab: 0 }, { kind: 'accept', tab: 0, mode: 'commit' }, { kind: 'reload', tab: 0 }, { kind: 'arrive-any' }, { kind: 'restore', tab: 0 }],
  [{ kind: 'edit', tab: 0 }, { kind: 'accept', tab: 0, mode: 'commit-lose' }, { kind: 'deliver', tab: 0 }, { kind: 'retry', tab: 0, mode: 'denied' }, { kind: 'deliver', tab: 0 }],
  [{ kind: 'edit', tab: 0 }, { kind: 'sign-out' }, { kind: 'accept', tab: 0, mode: 'commit' }, { kind: 'deliver', tab: 0 }, { kind: 'sign-in', tab: 0 }, { kind: 'duplicate-tab', tab: 0 },
    { kind: 'restore', tab: 0 }, { kind: 'restore', tab: 1 }, { kind: 'accept', tab: 0, mode: 'commit' }, { kind: 'deliver', tab: 0 }, { kind: 'edit', tab: 1 }, { kind: 'accept', tab: 1, mode: 'commit' }, { kind: 'deliver', tab: 1 }],
  [{ kind: 'edit', tab: 0 }, { kind: 'accept', tab: 0, mode: 'commit' }, { kind: 'sign-out' }, { kind: 'deliver', tab: 0 }, { kind: 'sign-in', tab: 0 }, { kind: 'restore', tab: 0 }],
];
const events: readonly string[] = ['edit', 'edit', 'edit', 'problem', 'accept', 'accept', 'accept', 'retry', 'retry', 'deliver', 'deliver', 'deliver', 'deliver-any', 'arrive-any',
  'leave', 'reload', 'leave-cancel', 'sign-out', 'restore', 'restore', 'drop', 'start-new', 'duplicate-tab'];

async function runModel(seed: number, sequences: number, maxLength: number): Promise<{ steps: number; reached: Set<string> }> {
  const rng = random(seed);
  let steps = 0;
  const reached = new Set<string>();
  for (let sequence = 0; sequence < sequences; sequence++) {
    const server = new FakeServer();
    let intentions = 0;
    let keys = 0;
    const requests: Request[] = [];
    // The intention each key was first sent under, so a restored draft is the same intention again.
    const keyIntention = new Map<string, number>();
    // Keys whose latest request's answer reached a screen of the tab (I7).
    const answered = new Map<Tab['store'], Set<string>>();
    const answeredIn = (store: Tab['store']) => { const found = answered.get(store) ?? new Set<string>(); answered.set(store, found); return found; };
    const mount = (store: Tab['store']): Tab => {
      const user: Omit<Tab, 'controller'> = { store, intention: ++intentions, outcome: null, request: null, mustSignIn: false };
      const tab: Tab = Object.assign(user, {
        controller: createDraftController<string>({
          start: blank(), makeKey: () => `k${sequence}-${++keys}`, store, failureOf, now: () => 'at',
          send: body => new Promise<string>((resolve, reject) => {
            const parsed: unknown = JSON.parse(body);
            assert.ok(typeof parsed === 'object' && parsed !== null && 'key' in parsed && 'content' in parsed);
            const { key, content } = parsed;
            assert.ok(typeof key === 'string' && typeof content === 'string');
            if (!keyIntention.has(key)) keyIntention.set(key, user.intention);
            const request: Request = {
              key, content, intention: user.intention, mode: 'commit', fromUnknown: false, arrived: false, delivered: false, served: null, result: null,
              owner: tab, orphan: false, pending: null, store, settle: outcome => outcome === 'ok' ? resolve('ok') : reject(outcome),
            };
            // A new request for the key: its answer is on the way again.
            answeredIn(store).delete(key);
            requests.push(request);
            tab.request = request;
          }),
        }),
      });
      return tab;
    };
    const tabs: Tab[] = [mount(memoryStore())];
    const where = (event: string) => `seed ${seed}, sequence ${sequence}, step ${steps}: ${event}`;
    const body = (tab: Tab) => { const machine = tab.controller.machine(); return JSON.stringify({ key: machine.key, content: JSON.stringify(machine.draft) }); };
    // A request's answer reaches the page that sent it (a left screen still gets it; a reloaded page does not).
    const deliver = async (request: Request) => {
      if (!request.arrived) server.arrive(request);
      request.delivered = true;
      if (request.orphan || request.result === null) return null;
      request.settle(request.result);
      await request.pending;
      // An answer that settles the save (saved, refused, conflict); no answer, a 401, 429 or denial says no more than
      // "never reached this tab".
      if (request.served === 'saved' || request.served === 'refused' || request.served === 'conflict') answeredIn(request.store).add(request.key);
      return request.served;
    };
    const remount = (tab: Tab, how: 'leave' | 'reload' | 'sign-in') => {
      const old = tab.controller.machine();
      // The old screen is no longer shown (a reloaded page is gone altogether).
      tab.controller.onScreen(false);
      if (tab.request && !tab.request.delivered) {
        if (how === 'reload') tab.request.orphan = true;
        tab.request.owner = null;
        reached.add(`${how} while sending`);
      }
      const fresh = mount(tab.store);
      tabs[tabs.indexOf(tab)] = fresh;
      // I6 (M1): a draft left, reloaded or signed out while sending, unknown or in conflict is offered on the next screen.
      if (old.phase !== 'editing' || tab.mustSignIn) {
        assert.ok(fresh.controller.machine().offered.some(entry => entry.key === old.key), where(`I6: ${how} from ${old.phase} forgot key ${old.key}`));
        reached.add(`${how} from ${old.phase} offered back`);
      }
      return fresh;
    };
    const opening = rng.next() < 0.25 ? rng.pick(openings) : [];
    const length = Math.max(opening.length, 1 + Math.floor(rng.next() * maxLength));
    for (let index = 0; index < length; index++, steps++) {
      const scripted = opening[index];
      let tab = tabs[scripted?.tab ?? Math.floor(rng.next() * tabs.length)] ?? tabs[0];
      let event = scripted?.kind ?? rng.pick(events);
      if (tab.mustSignIn && !scripted) event = 'sign-in';
      const mode = scripted?.mode ?? rng.pick(modes);
      const before = new Map(tabs.map(each => [each, each.controller.machine()]));
      const keyMayChange = new Set<Tab>();
      const startSend = (pending: Promise<unknown> | null, fromUnknown: boolean) => {
        if (!pending || !tab.request) return;
        tab.request.mode = mode;
        tab.request.fromUnknown = fromUnknown;
        tab.request.pending = pending;
      };
      let label = event;
      switch (event) {
        case 'edit': tab.controller.edit(rng.pick<DraftAction>([{ type: 'narration', text: rng.pick(['', 'a', 'b']) }, { type: 'account', ledger: rng.pick(['', 'l-1', 'l-2']) }])); break;
        case 'problem': tab.controller.problem('check'); break;
        case 'accept': startSend(tab.controller.save(body(tab)), false); break;
        case 'retry': startSend(tab.controller.retry(), true); break;
        case 'deliver': case 'deliver-any': {
          const open = requests.filter(request => !request.delivered && (event === 'deliver-any' || request.owner === tab));
          if (!open.length) break;
          const request = rng.pick(open);
          const owner = request.owner;
          const wasUnknown = request.fromUnknown;
          const served = await deliver(request);
          label = `${event} ${served ?? 'lost'}${owner ? '' : request.orphan ? ' to a gone page' : ' to a left screen'}`;
          if (!owner || served === null) break;
          owner.request = null;
          if (served === 'saved') { owner.intention = ++intentions; owner.outcome = null; keyMayChange.add(owner); }
          else if (served === 'refused') owner.outcome = null;
          else if (served === 'conflict') owner.outcome = 'conflict';
          else if (served === 'none') owner.outcome = 'unknown';
          else if (served === 'signed-out') owner.mustSignIn = true;
          // A denial from editing shows like a refusal; from unknown nothing changes (the outcome stays).
          // I5: from unknown a definite answer leaves unknown; one that never reached the replay never does.
          const phase = owner.controller.machine().phase;
          if (wasUnknown) {
            if (served === 'saved' || served === 'refused' || served === 'conflict') assert.notEqual(phase, 'unknown', where(`I5: ${served} left the draft unknown`));
            else assert.equal(phase, 'unknown', where(`I5: ${served} left unknown`));
            label = `unknown retry ${served} ${phase}`;
          } else label = `${before.get(owner)?.phase === 'sending' ? 'accept' : '?'} ${served} ${phase}`;
          break;
        }
        case 'arrive-any': { const open = requests.filter(request => !request.arrived); if (open.length) server.arrive(rng.pick(open)); break; }
        case 'leave': tab = remount(tab, 'leave'); break;
        case 'reload': tab = remount(tab, 'reload'); break;
        case 'sign-in': server.sessionAlive = true; tab = remount(tab, 'sign-in'); break;
        case 'sign-out': server.sessionAlive = false; label = tabs.some(each => each.request && !each.request.delivered) ? 'sign-out while sending' : 'sign-out'; break;
        case 'leave-cancel': break;
        case 'restore': {
          // What the tab holds now (the controller rereads it before a restore: another screen may have rewritten it).
          const offered = storedDraftsOf(tab.store.read()).filter(entry => entry.key !== tab.controller.machine().key)[0];
          if (offered && tab.controller.restore()) {
            tab.intention = keyIntention.get(offered.key) ?? ++intentions;
            tab.outcome = offered.phase === 'editing' || offered.phase === 'saved' ? null : offered.phase;
            keyMayChange.add(tab);
            assert.equal(tab.controller.machine().key, offered.key, where('I3: a restore brings the kept draft\'s own key'));
            label = `restored ${offered.phase}`;
          }
          break;
        }
        case 'drop': tab.controller.drop(); break;
        case 'start-new': {
          const phase = tab.controller.machine().phase;
          if (tab.controller.discard(blank())) { tab.intention = ++intentions; tab.outcome = null; keyMayChange.add(tab); label = `${phase} start-new`; }
          break;
        }
        case 'duplicate-tab': if (tabs.length < 2) { const copy = memoryStore(tab.store.read()); answered.set(copy, new Set(answeredIn(tab.store))); tabs.push(mount(copy)); } break;
      }
      reached.add(label);
      // I7: a kept entry never says its answer never reached the tab once an answer settling that save reached a screen of it.
      for (const each of new Set(tabs.map(one => one.store))) {
        for (const entry of storedDraftsOf(each.read())) {
          if (entry.message === answerNeverArrived) assert.ok(!answeredIn(each).has(entry.key), where(`I7: ${entry.key} still says its answer never arrived (${label})`));
          if (entry.phase === 'saved') reached.add('a left screen wrote its saved notice');
        }
      }
      // I1: one intention, at most one voucher.
      const perIntention = new Map<number, number>();
      for (const commit of server.commits) perIntention.set(commit.intention, (perIntention.get(commit.intention) ?? 0) + 1);
      for (const [intention, count] of perIntention) assert.ok(count <= 1, where(`I1: intention ${intention} has ${count} vouchers`));
      for (const each of tabs) {
        const was = before.get(each);
        const now = each.controller.machine();
        if (was) {
          // I2: in sending, unknown and conflict the content and the key never change.
          if (was.phase !== 'editing' && now.phase !== 'editing') assert.deepEqual([now.key, now.draft], [was.key, was.draft], where(`I2: ${was.phase} to ${now.phase} changed the draft or key (${label})`));
          // I3: the key changes only on a save, a discard, or a restore (to the kept draft's own key).
          if (now.key !== was.key) assert.ok(keyMayChange.has(each), where(`I3: the key changed on ${label}`));
        }
        // I4: the alert is shown exactly in unknown and conflict, as the server's answers say it must be.
        const expected = each.request && !each.request.delivered ? null : each.outcome;
        assert.equal(lockAlert(now)?.phase ?? null, expected, where(`I4: alert ${lockAlert(now)?.phase ?? 'none'}, expected ${expected ?? 'none'} after ${label}`));
      }
    }
  }
  return { steps, reached };
}

// Several fixed seeds; MODEL_SEEDS and MODEL_SEQUENCES run others. The scripted openings make the reach below hold for
// any seed at a few thousand sequences, not only for these.
const seeds = process.env.MODEL_SEEDS?.split(',').map(Number) ?? [20261115, 1, 424242];
const sequences = Number(process.env.MODEL_SEQUENCES ?? 5000);

// The reach is asserted for each seed on its own, not over their union.
test(`the model: ${sequences} random sequences of up to 40 steps per seed (${seeds.join(', ')}), requests in flight across steps, keep I1 to I7`, async () => {
  for (const seed of seeds) {
    const started = performance.now();
    const { steps, reached } = await runModel(seed, sequences, 40);
    console.log(`model: seed ${seed}, ${sequences} sequences, ${steps} steps, ${Math.round(performance.now() - started)} ms`);
    assertReach(seed, reached);
  }
});

function assertReach(seed: number, union: Set<string>) {
  for (const wanted of [
    'restored unknown', 'restored editing', 'restored conflict', 'leave while sending', 'reload while sending', 'leave from sending offered back', 'reload from sending offered back',
    'leave from unknown offered back', 'leave from conflict offered back', 'sign-in from editing offered back', 'sign-out while sending',
    'deliver-any saved to a left screen', 'deliver-any none to a left screen', 'deliver-any lost to a gone page',
    'unknown retry signed-out unknown', 'unknown retry limited unknown', 'unknown retry denied unknown', 'unknown retry saved editing', 'unknown retry refused editing',
    'unknown retry none unknown', 'accept conflict conflict', 'accept denied editing', 'accept none unknown', 'conflict start-new', 'unknown start-new',
    'a left screen wrote its saved notice',
  ]) assert.ok(union.has(wanted), `seed ${seed} reaches: ${wanted}`);
}
