import { createCompany, getCompany, listCompanies, setUpCompany } from '../companies.ts';
import { readJson } from '../validation.ts';
import { json, limit, methodNotAllowed, type SignedInArea } from './http.ts';

const id = '[0-9a-f-]{36}';

/**
 * Companies (D-03 as amended): a company is a workspace, so its id is the workspace id. The list and creation belong to
 * the signed-in user; every read or change of one company goes through withCompany. Renaming is the workspace rename
 * (POST /api/workspaces/<id>/rename), and the team is the workspace team.
 */
export const companiesApi: SignedInArea = async ({ request, path, user }) => {
  if (path === '/api/companies') {
    if (request.method === 'GET') return json({ companies: await listCompanies(user.id) });
    if (request.method === 'POST') {
      await limit(`companies:${user.id}`, 20);
      const { company, replayed } = await createCompany(user.id, await readJson(request));
      return json({ company, replayed }, replayed ? 200 : 201);
    }
    return methodNotAllowed('GET, POST');
  }
  let match = path.match(new RegExp(`^/api/companies/(${id})$`, 'i'));
  if (match) {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    return json({ company: await getCompany(user.id, match[1]) });
  }
  match = path.match(new RegExp(`^/api/companies/(${id})/setup$`, 'i'));
  if (match) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    await limit(`companies:${user.id}`, 20);
    return json({ company: await setUpCompany(user.id, match[1], await readJson(request)) });
  }
  return null;
};
