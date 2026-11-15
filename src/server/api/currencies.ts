import { readLedgerBody, runLedger, type LedgerContext } from '../ledger/context.ts';
import {
  alterCurrency, createCurrency, currencyRates, currencyRevisions, deleteCurrency, getCurrency, listCurrencies, ratesOn, saveRates,
} from '../ledger/currencies.ts';
import { json, limit, type SignedInArea } from './http.ts';
import { queryOf } from './reports.ts';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const company = `^/api/companies/(${uuid})`;
// A code in the path is three letters, matched without case and addressed in capitals.
/**
 * Currency and rate bodies: a rates write names at most 200 currencies (`rates`, src/lib/currencies.ts). A row at its bounds
 * is under 128 bytes (a code and three rates of 15 characters), plus 1 KiB for the date and the envelope.
 */
export const currencyBodyBytes = 200 * 128 + 1024;
const currencyRoute = new RegExp(`${company}/currencies(?:/([a-z]{3})(?:/(delete|revisions|rates))?)?$`, 'i');
const ratesRoute = new RegExp(`${company}/exchange-rates$`, 'i');
const notAllowed = (allow: string) => json({ error: 'Method not allowed.' }, 405, { allow });

/**
 * Currencies and dated rates (M2a currencies, slice a), shaped like the masters routes: viewers read, owners, admins and
 * editors write, every change is a POST, and every route runs through withCompany via runLedger, so a company the user
 * cannot reach answers "not found".
 */
export const currenciesApi: SignedInArea = async ({ request, url, path, user }) => {
  const write = async (companyId: string, run: (context: LedgerContext, body: unknown) => Promise<unknown>) => {
    await limit(`masters:${user.id}`, 120);
    const body = await readLedgerBody(request, currencyBodyBytes);
    return runLedger(user.id, companyId, 'write', context => run(context, body));
  };

  const rates = path.match(ratesRoute);
  if (rates) {
    const companyId = rates[1];
    if (request.method === 'GET') return json({ rates: await runLedger(user.id, companyId, 'read', context => ratesOn(context, queryOf(url, ['date']))) });
    if (request.method === 'POST') return json({ rates: await write(companyId, saveRates) });
    return notAllowed('GET, POST');
  }
  const match = path.match(currencyRoute);
  if (!match) return null;
  // The code and action groups are optional: absent, they are undefined at run time, so they are read with ?. below.
  const [, companyId, rawCode, rawAction] = match;
  const code = rawCode?.toUpperCase(), action = rawAction?.toLowerCase();
  if (!code) {
    if (request.method === 'GET') return json({ currencies: await runLedger(user.id, companyId, 'read', listCurrencies) });
    if (request.method === 'POST') return json({ currency: await write(companyId, createCurrency) }, 201);
    return notAllowed('GET, POST');
  }
  if (action === 'revisions' || action === 'rates') {
    if (request.method !== 'GET') return notAllowed('GET');
    if (action === 'rates') return json({ rates: await runLedger(user.id, companyId, 'read', context => currencyRates(context, code)) });
    return json({ revisions: await runLedger(user.id, companyId, 'read', context => currencyRevisions(context, code)) });
  }
  if (action === 'delete') {
    if (request.method !== 'POST') return notAllowed('POST');
    await write(companyId, (context, body) => deleteCurrency(context, code, body));
    return json({ deleted: true });
  }
  if (request.method === 'GET') return json({ currency: await runLedger(user.id, companyId, 'read', context => getCurrency(context, code)) });
  if (request.method === 'POST') return json({ currency: await write(companyId, (context, body) => alterCurrency(context, code, body)) });
  return notAllowed('GET, POST');
};
