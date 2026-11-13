import { createCompany, getCompany, listCompanies } from '../companies.ts';
import { readJson } from '../validation.ts';
import { json, limit, type SignedInArea } from './http.ts';

const id = '[0-9a-f-]{36}';

/** Companies (D-03): creation is workspace-authorized; every company read goes through withCompany. */
export const companiesApi: SignedInArea = async ({ request, path, user }) => {
  let match = path.match(new RegExp(`^/api/workspaces/(${id})/companies$`, 'i'));
  if (match) {
    if (request.method === 'GET') return json({ companies: await listCompanies(user.id, match[1].toLowerCase()) });
    if (request.method === 'POST') {
      await limit(`companies:${user.id}`, 20);
      return json({ company: await createCompany(user.id, match[1].toLowerCase(), await readJson(request)) }, 201);
    }
    return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, POST' });
  }
  match = path.match(new RegExp(`^/api/companies/(${id})$`, 'i'));
  if (match) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405, { allow: 'GET' });
    return json({ company: await getCompany(user.id, match[1]) });
  }
  return null;
};
