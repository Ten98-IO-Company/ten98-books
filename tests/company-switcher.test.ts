import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { workspaceOptions, type Company, type CompanySummary } from '../src/lib/company.ts';

const summary = (id: string, name: string, role: CompanySummary['role'], extra: Partial<CompanySummary> = {}): CompanySummary =>
  ({ id, name, role, twoFactorLocked: false, company: {} as Company, ...extra });

test('the switcher lists every company with its role, and "not set up yet" only for a company without books settings that is not locked', () => {
  assert.equal(workspaceOptions(null), null, 'null while the list loads');
  assert.deepEqual(workspaceOptions([]), [], 'an empty list stays empty (the package says "No companies yet")');
  assert.deepEqual(workspaceOptions([
    summary('a', 'Alpha', 'owner'),
    summary('b', 'Beta', 'viewer', { company: null }),
    summary('c', 'Gamma', 'editor', { company: null, twoFactorLocked: true }),
    summary('d', 'Delta', 'admin'),
  ]), [
    { id: 'a', name: 'Alpha', roleLabel: 'Owner' },
    { id: 'b', name: 'Beta', roleLabel: 'Viewer · not set up yet' },
    { id: 'c', name: 'Gamma', roleLabel: 'Editor' },
    { id: 'd', name: 'Delta', roleLabel: 'Admin' },
  ]);
});

test('the shell hands the switcher the company list, the company in view and the open-company action', () => {
  const shell = readFileSync(new URL('../src/routes/app.tsx', import.meta.url), 'utf8');
  assert.match(shell, /<WorkspaceProjectSwitcher workspaces=\{workspaceOptions\(companies\)\} workspaceId=\{shown\?\.id \?\? null\} onWorkspaceChange=\{openCompany\}/);
  assert.match(shell, /create=\{createCompany\}/);
  assert.match(shell, /const createCompany = \{ label: 'Create company', href: '\/app\/companies\/new' \}/);
});
