import { z } from 'zod';
import { defaultKeymap, keymapNames, type KeymapName } from '../../lib/keymaps.ts';
import { getDatabase } from '../db.ts';
import { readJson } from '../validation.ts';
import { json, limit, type SignedInArea } from './http.ts';

const keymapInput = z.object({ keymap: z.enum(keymapNames) }).strict();

export type KeymapSetting = { keymap: KeymapName; chosen: boolean };

/**
 * GET and PUT /api/account/keymap: the signed-in user's keymap (D-05). The route carries no user id, so a user can only
 * ever read and write their own row. `chosen` is false until the user picks one; the default then applies.
 */
export const settingsApi: SignedInArea = async ({ request, path, user }) => {
  if (path !== '/api/account/keymap') return null;
  const { pool } = getDatabase();
  if (request.method === 'GET') {
    await limit(`account-keymap:read:${user.id}`, 120);
    const { rows } = await pool.query<{ keymap: KeymapName }>('SELECT keymap FROM user_keymap WHERE user_id=$1', [user.id]);
    return json({ keymap: rows[0]?.keymap ?? defaultKeymap, chosen: rows.length > 0 } satisfies KeymapSetting);
  }
  if (request.method === 'PUT') {
    await limit(`account-keymap:write:${user.id}`, 30);
    const { keymap } = keymapInput.parse(await readJson(request));
    await pool.query(`INSERT INTO user_keymap(user_id, keymap) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET keymap=excluded.keymap, updated_at=now()`, [user.id, keymap]);
    return json({ keymap, chosen: true } satisfies KeymapSetting);
  }
  return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, PUT' });
};
