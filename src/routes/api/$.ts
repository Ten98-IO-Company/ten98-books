import { createFileRoute } from '@tanstack/react-router';
import { handleApi } from '../../server/api.ts';

export const Route = createFileRoute('/api/$')({
  server: { handlers: { ANY: ({ request }) => handleApi(request) } },
});
