import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { emailLimitKey } from '../src/server/client-rate-limit.ts';
import { inviteResultText } from '../src/lib/team-roles.ts';
import { freshDatabase, type TestDatabase } from './helpers/database.ts';
import { asAdmin, setupOwner, type Member } from './helpers/ledger.ts';

/**
 * Invitation email outcomes: `limited` when a send limit refused the email, `failed` when the provider could not take it
 * (here an SMTP host that does not resolve), each with one log line naming the reason and the invitation id and nothing
 * of the address, the link or the token; and the screen's sentence for `limited`.
 */
let database: TestDatabase;
let owner: Member & { workspaceId: string };
const saved: Record<string, string | undefined> = {};
const email = { EMAIL_TRANSPORT: 'smtp', EMAIL_FROM: 'books@books.test', EMAIL_SMTP_HOST: 'mail.invalid', EMAIL_SMTP_USER: 'books', EMAIL_SMTP_PASSWORD: 'not-a-real-password' };

before(async () => {
  database = await freshDatabase('invitation_email');
  owner = await setupOwner();
  for (const [key, value] of Object.entries(email)) { saved[key] = process.env[key]; process.env[key] = value; }
});
after(async () => {
  for (const key of Object.keys(email)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  await database?.drop();
});

/** Invites `address` and returns the answer and the warning lines written meanwhile. */
async function inviteLogged(t: { mock: { method: (object: object, name: string, implementation: (...args: unknown[]) => void) => { mock: { calls: { arguments: unknown[] }[] } } } }, address: string) {
  const warn = t.mock.method(console, 'warn', () => undefined);
  const answer = await owner.browser.call(`/api/workspaces/${owner.workspaceId}/invitations`, { email: address, role: 'viewer' });
  return { answer, lines: warn.mock.calls.map(call => String(call.arguments[0])) };
}

test('a failed send answers failed and logs one line with the reason and the invitation id only', async t => {
  const address = `failed-${randomUUID()}@books.test`;
  const { answer, lines } = await inviteLogged(t, address);
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  assert.equal(answer.body.email, 'failed');
  assert.deepEqual(lines, [`Invitation email not sent: failed (invitation ${answer.body.invitation.id}).`]);
  assert.ok(!lines.join(' ').includes(address) && !lines.join(' ').includes(answer.body.inviteUrl.split('#invite=')[1]), 'no address and no token');
});

test('a send refused by its own limit answers limited, not failed, and logs one line', async t => {
  const address = `limited-${randomUUID()}@books.test`;
  await asAdmin(database.adminUrl, admin => admin.query('INSERT INTO request_limit (key, minute, count) VALUES ($1, floor(extract(epoch FROM now()) / 60), 3)', [emailLimitKey('invitation-email', address)]));
  const { answer, lines } = await inviteLogged(t, address);
  assert.deepEqual([answer.status, answer.body.email], [201, 'limited']);
  assert.deepEqual(lines, [`Invitation email not sent: limited (invitation ${answer.body.invitation.id}).`]);
});

test('the screen tells a limited send from a failed one, without numbers', () => {
  const limited = inviteResultText({ kind: 'create', delivery: 'limited', email: 'someone@books.test' });
  assert.notEqual(limited, inviteResultText({ kind: 'create', delivery: 'failed', email: 'someone@books.test' }));
  assert.match(limited, /share this link yourself, or send it again later/i);
  assert.doesNotMatch(limited, /\d/);
});

test('an email admit that fails for a reason other than a limit answers failed, not limited', async t => {
  const address = `admit-${randomUUID()}@books.test`;
  const key = emailLimitKey('invitation-email', address).replaceAll("'", "''");
  // The limit store refuses this address's count with an error that is not a limit's 429.
  await asAdmin(database.adminUrl, async admin => {
    await admin.query("CREATE FUNCTION test_limit_store_down() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'limit store unavailable'; END $$");
    await admin.query(`CREATE TRIGGER test_limit_store_down BEFORE INSERT ON request_limit FOR EACH ROW WHEN (NEW.key = '${key}') EXECUTE FUNCTION test_limit_store_down()`);
  });
  // The send's own failure answers failed too: the installation-wide count shows the admit stopped before it, unspent.
  const globalCount = () => asAdmin(database.adminUrl, async admin => Number((await admin.query("SELECT COALESCE(sum(count), 0) AS total FROM request_limit WHERE key = 'invitation-email:global'")).rows[0].total));
  try {
    const before = await globalCount();
    const { answer, lines } = await inviteLogged(t, address);
    assert.deepEqual([answer.status, answer.body.email], [201, 'failed']);
    assert.equal(await globalCount(), before, 'the admit stopped at the address count');
    assert.deepEqual(lines, [`Invitation email not sent: failed (invitation ${answer.body.invitation.id}).`]);
  } finally {
    await asAdmin(database.adminUrl, admin => admin.query('DROP TRIGGER test_limit_store_down ON request_limit; DROP FUNCTION test_limit_store_down()'));
  }
});
