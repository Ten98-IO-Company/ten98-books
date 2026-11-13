-- The keyboard keymap each user chose (D-05). An account setting like the identity tables: it has no company column and
-- stays outside row-level security. The handler (src/server/api/settings.ts) reads and writes only the signed-in user's
-- row. Run by the migrator role, which owns the table; the application role may read, add and change rows, not delete
-- them (removing a user removes the row through the foreign key).
CREATE TABLE user_keymap (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  keymap text NOT NULL CHECK (keymap IN ('classic', 'web-safe')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON user_keymap TO books_app;
