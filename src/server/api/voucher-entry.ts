import { readLedgerBody, runLedger } from '../ledger/context.ts';
import { balancePreview, counterLedger, nextNumber } from '../ledger/voucher-entry.ts';
import { json, type SignedInArea } from './http.ts';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const company = `^/api/companies/(${uuid})`;
const nextNumberRoute = new RegExp(`${company}/voucher-types/(${uuid})/next-number$`, 'i');
const balancePreviewRoute = new RegExp(`${company}/vouchers/balance-preview$`, 'i');
const counterLedgerRoute = new RegExp(`${company}/ledgers/(${uuid})/counter-ledger$`, 'i');
const notAllowed = (allow: string) => json({ error: 'Method not allowed.' }, 405, { allow });
/** A preview carries at most 500 lines, as a voucher does. */
const previewBodyBytes = 128 * 1024;

/** The query string as an object; a repeated parameter becomes a list, which the strict schemas refuse. */
function queryOf(url: URL): Record<string, unknown> {
  return Object.fromEntries([...new Set(url.searchParams.keys())].map(key => {
    const values = url.searchParams.getAll(key);
    return [key, values.length === 1 ? values[0] : values];
  }));
}

/**
 * Reads for the voucher entry screen (docs/LEDGER.md, "Voucher entry reads"): the expected next number, the resulting
 * balances of a draft, and the counter ledger a new line proposes. All run through withCompany via runLedger in read
 * mode, so viewers may call them; the preview is a POST only because it carries the draft, and the central origin gate
 * in api.ts covers it like every POST.
 */
export const voucherEntryApi: SignedInArea = async ({ request, url, path, user }) => {
  let match = path.match(nextNumberRoute);
  if (match) {
    if (request.method !== 'GET') return notAllowed('GET');
    const typeId = match[2].toLowerCase();
    return json(await runLedger(user.id, match[1], 'read', context => nextNumber(context, typeId, queryOf(url))));
  }
  match = path.match(counterLedgerRoute);
  if (match) {
    if (request.method !== 'GET') return notAllowed('GET');
    const ledgerId = match[2].toLowerCase();
    return json(await runLedger(user.id, match[1], 'read', context => counterLedger(context, ledgerId, queryOf(url))));
  }
  match = path.match(balancePreviewRoute);
  if (match) {
    if (request.method !== 'POST') return notAllowed('POST');
    const body = await readLedgerBody(request, previewBodyBytes);
    return json(await runLedger(user.id, match[1], 'read', context => balancePreview(context, body)));
  }
  return null;
};
