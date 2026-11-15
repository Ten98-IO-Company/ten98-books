import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createDisplayFormatter } from '@ten98/ui';
import { canonicalAccountTimeZone } from '../src/lib/account-preferences.ts';

const source = (file: string) => readFileSync(new URL(`../src/components/${file}`, import.meta.url), 'utf8');
const masterForms = ['GroupForm', 'LedgerForm', 'CostCategoryForm', 'CostCentreForm'];

test('every masters form with a Name shows a duplicate_name refusal on the Name field, keeps its values, refocuses Name, and clears the message when a field is edited', () => {
  for (const name of masterForms) {
    const text = source(`masters/${name}.tsx`);
    const effect = /useEffect\(\(\) => \{\s*if \(failure\?\.code !== 'duplicate_name'\) return\s*setErrors\(previous => \(\{ \.\.\.previous, name: failure\.message \}\)\)\s*focusEntryField\(form\.current, 'name'\)\s*\}, \[failure\]\)/;
    assert.match(text, effect, `${name}: the refusal goes to the Name field and focus returns to it`);
    assert.match(text, /<FailureAlert failure=\{failure\?\.code === 'duplicate_name' \? null : failure\}/, `${name}: the message is not repeated in the page alert`);
    const set = text.split('\n').find(line => line.includes('const set = ')) ?? '';
    assert.match(set, /setErrors\(previous => \(\{ \.\.\.previous, \[field\]: undefined \}\)\)/, `${name}: editing a field clears its message`);
  }
});

test('LookupField lists through filterChoices, so names are compared under the name match key', () => {
  const text = source('masters/LookupField.tsx');
  assert.match(text, /import \{ filterChoices \} from '\.\.\/\.\.\/lib\/lookup-entry'/);
  assert.match(text, /filterChoices\(options, typed\)/);
  assert.match(text, /filter=\{false\}/, 'the combobox does not filter on the text as written');
});

test('the security panel gives the display format a canonical zone or UTC: a zone this browser does not know must not throw during render', () => {
  assert.throws(() => createDisplayFormatter({ locale: 'en-US', timeZone: 'Mars/Olympus' }), RangeError, 'the shared formatter throws for an unknown zone');
  assert.equal(canonicalAccountTimeZone('Mars/Olympus'), null);
  assert.equal(canonicalAccountTimeZone('Asia/Dubai'), 'Asia/Dubai');
  assert.match(source('AccountSecurityPanel.tsx'), /timeZone=\{canonicalAccountTimeZone\(preferences\.timeZone\) \?\? 'UTC'\}/);
  assert.doesNotThrow(() => createDisplayFormatter({ locale: 'en-US', timeZone: canonicalAccountTimeZone('Mars/Olympus') ?? 'UTC' }));
});
