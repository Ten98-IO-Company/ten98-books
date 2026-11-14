import { periodQuery } from '../../lib/ledger.ts';
import { parseInput, readLedgerBody, runLedger, type LedgerContext } from '../ledger/context.ts';
import { ledgerBalance, trialBalance } from '../ledger/reports.ts';
import { listRevisions } from '../ledger/revisions.ts';
import { alterVoucher, cancelVoucher, createVoucher, deleteVoucher, listVouchers, readVoucher } from '../ledger/vouchers.ts';
import { json, limit, type SignedInArea } from './http.ts';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const company = `^/api/companies/(${uuid})`;
const vouchersRoute = new RegExp(`${company}/vouchers(?:/(${uuid})(?:/(cancel|delete|revisions))?)?$`, 'i');
const trialBalanceRoute = new RegExp(`${company}/trial-balance$`, 'i');
const ledgerBalanceRoute = new RegExp(`${company}/ledgers/(${uuid})/balance$`, 'i');
const notAllowed = (allow: string) => json({ error: 'Method not allowed.' }, 405, { allow });
/** Voucher bodies carry up to 500 lines. */
const voucherBodyBytes = 256 * 1024;

const period = (url: URL) => parseInput(periodQuery, { from: url.searchParams.get('from'), to: url.searchParams.get('to') },
  path => path[0] === 'to' ? 'the end date' : path[0] === 'from' ? 'the start date' : 'the period');

/**
 * Vouchers of one company and the verification read model (trial balance, ledger balance). Every route runs through
 * withCompany via runLedger: viewers read, owners, admins and editors post. State changes are POST, covered by the
 * central origin gate in api.ts; the body is read before the company transaction opens so posting stays short.
 */
export const vouchersApi: SignedInArea = async ({ request, url, path, user }) => {
  let match = path.match(trialBalanceRoute);
  if (match) {
    if (request.method !== 'GET') return notAllowed('GET');
    const { from, to } = period(url);
    return json({ trialBalance: await runLedger(user.id, match[1], 'read', context => trialBalance(context, from, to)) });
  }
  match = path.match(ledgerBalanceRoute);
  if (match) {
    if (request.method !== 'GET') return notAllowed('GET');
    const { from, to } = period(url);
    const ledgerId = match[2].toLowerCase();
    return json({ balance: await runLedger(user.id, match[1], 'read', context => ledgerBalance(context, ledgerId, from, to)) });
  }
  match = path.match(vouchersRoute);
  if (!match) return null;
  const companyId = match[1], voucherId = match[2]?.toLowerCase(), action = match[3]?.toLowerCase();
  const write = async <T>(run: (context: LedgerContext, body: unknown) => Promise<T>) => {
    await limit(`vouchers:${user.id}`, 600);
    const body = await readLedgerBody(request, voucherBodyBytes);
    return runLedger(user.id, companyId, 'write', context => run(context, body));
  };

  if (!voucherId) {
    if (request.method === 'GET') {
      // ?from=&to=[&limit=][&after=]; parameters absent from the URL stay absent so their defaults apply.
      const query = Object.fromEntries(['from', 'to', 'limit', 'after'].flatMap(key => url.searchParams.has(key) ? [[key, url.searchParams.get(key)]] : []));
      return json(await runLedger(user.id, companyId, 'read', context => listVouchers(context, query)));
    }
    if (request.method === 'POST') {
      const result = await write(createVoucher);
      return json(result, result.replayed ? 200 : 201);
    }
    return notAllowed('GET, POST');
  }
  if (action === 'revisions') {
    if (request.method !== 'GET') return notAllowed('GET');
    return json({ revisions: await runLedger(user.id, companyId, 'read', context => listRevisions(context, 'voucher', voucherId)) });
  }
  if (action === 'cancel') {
    if (request.method !== 'POST') return notAllowed('POST');
    return json({ voucher: await write((context, body) => cancelVoucher(context, voucherId, body)) });
  }
  if (action === 'delete') {
    if (request.method !== 'POST') return notAllowed('POST');
    await write((context, body) => deleteVoucher(context, voucherId, body));
    return json({ deleted: true });
  }
  if (request.method === 'GET') return json({ voucher: await runLedger(user.id, companyId, 'read', context => readVoucher(context, voucherId)) });
  if (request.method === 'POST') return json({ voucher: await write((context, body) => alterVoucher(context, voucherId, body)) });
  return notAllowed('GET, POST');
};
