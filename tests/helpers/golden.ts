import type { Browser } from './database.ts';
import { addLedger, chart, createCompany, post, type Chart, type Line } from './ledger.ts';

/**
 * The golden fixture: a small trading company's first five weeks, 18 vouchers across the eight voucher types, with
 * opening balances. The expected figures are the accounting outcome accountants expect from this set of entries; the
 * ledger names, narrations and company are this project's own. Shared by the ledger and the report tests.
 */
export const goldenVouchers: [kind: string, date: string, lines: [ledger: string, side: 'Dr' | 'Cr', amount: string][]][] = [
  ['payment', '2026-01-01', [['Premises Rent', 'Dr', '4000'], ['Harbour Bank', 'Cr', '4000']]],
  ['receipt', '2026-01-02', [["Owners' Capital", 'Cr', '20000'], ['Cash', 'Dr', '20000']]],
  ['contra', '2026-01-04', [['Cash', 'Cr', '5000'], ['Harbour Bank', 'Dr', '5000']]],
  ['payment', '2026-01-06', [['Wages', 'Dr', '3000'], ['Cash', 'Cr', '3000']]],
  ['journal', '2026-01-07', [['Promotion', 'Dr', '500'], ['Supplier South', 'Cr', '500']]],
  ['purchase', '2026-01-08', [['Supplier South', 'Cr', '6300'], ['Trade Purchases', 'Dr', '6000'], ['Input Tax', 'Dr', '300']]],
  ['sales', '2026-01-10', [['Customer North', 'Dr', '9450'], ['Trade Sales', 'Cr', '9000'], ['Output Tax', 'Cr', '450']]],
  ['receipt', '2026-01-12', [['Customer North', 'Cr', '2000'], ['Harbour Bank', 'Dr', '2000']]],
  ['payment', '2026-01-16', [['Supplier South', 'Dr', '6300'], ['Harbour Bank', 'Cr', '6300']]],
  ['purchase', '2026-01-18', [['Supplier South', 'Cr', '2100'], ['Trade Purchases', 'Dr', '2000'], ['Input Tax', 'Dr', '100']]],
  ['sales', '2026-01-20', [['Customer North', 'Dr', '3150'], ['Trade Sales', 'Cr', '3000'], ['Output Tax', 'Cr', '150']]],
  ['credit_note', '2026-01-22', [['Customer North', 'Cr', '1050'], ['Trade Sales', 'Dr', '1000'], ['Output Tax', 'Dr', '50']]],
  ['debit_note', '2026-01-23', [['Supplier South', 'Dr', '525'], ['Trade Purchases', 'Cr', '500'], ['Input Tax', 'Cr', '25']]],
  ['contra', '2026-01-25', [['Harbour Bank', 'Cr', '1000'], ['Cash', 'Dr', '1000']]],
  ['journal', '2026-01-28', [['Equipment', 'Dr', '8000'], ['Supplier South', 'Cr', '8000']]],
  ['receipt', '2026-01-30', [['Customer North', 'Cr', '9450'], ['Harbour Bank', 'Dr', '9450']]],
  ['payment', '2026-01-31', [['Promotion', 'Dr', '400'], ['Cash', 'Cr', '400']]],
  ['payment', '2026-02-03', [['Wages', 'Dr', '3000'], ['Cash', 'Cr', '3000']]],
];

/** Creates the golden company's masters (one extra group and twelve ledgers with their opening balances). */
export async function goldenMasters(member: Browser, companyId: string): Promise<Chart> {
  const books = await chart(member, companyId);
  const promotionCosts = (await member.call(`/api/companies/${companyId}/groups`, { name: 'Promotion Costs', parentId: books.group('indirect_expenses') })).body.group.id;
  await addLedger(member, companyId, 'Harbour Bank', books.group('bank_accounts'), { amount: '10000', side: 'Dr' });
  await addLedger(member, companyId, 'Customer North', books.group('receivables'), { amount: '2000', side: 'Dr' });
  await addLedger(member, companyId, 'Supplier South', books.group('payables'));
  await addLedger(member, companyId, "Owners' Capital", books.group('capital'), { amount: '12000', side: 'Cr' });
  await addLedger(member, companyId, 'Equipment', books.group('fixed_assets'));
  await addLedger(member, companyId, 'Output Tax', books.group('duties_taxes'));
  await addLedger(member, companyId, 'Input Tax', books.group('duties_taxes'));
  await addLedger(member, companyId, 'Trade Sales', books.group('sales'));
  await addLedger(member, companyId, 'Trade Purchases', books.group('purchases'));
  await addLedger(member, companyId, 'Premises Rent', books.group('indirect_expenses'));
  await addLedger(member, companyId, 'Wages', books.group('indirect_expenses'));
  await addLedger(member, companyId, 'Promotion', promotionCosts);
  return chart(member, companyId);
}

/** Posts the 18 golden vouchers in order; returns them as the API answered. */
export async function postGoldenVouchers(member: Browser, companyId: string, books: Chart): Promise<any[]> {
  const posted = [];
  for (const [kind, date, lines] of goldenVouchers) {
    posted.push(await post(member, companyId, books.type(kind), date, lines.map(([name, side, amount]): Line => [books.ledger(name), side, amount]), { narration: `Golden entry ${posted.length + 1}` }));
  }
  return posted;
}

/** A new company with the whole golden fixture posted. */
export async function goldenCompany(member: Browser, name = 'Golden Trading'): Promise<{ companyId: string; books: Chart }> {
  const companyId = await createCompany(member, { name });
  const books = await goldenMasters(member, companyId);
  await postGoldenVouchers(member, companyId, books);
  return { companyId, books };
}
