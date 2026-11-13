import { z } from 'zod';

// Imported first by the router module so it runs before any schema module is evaluated: in the browser zod's JIT probes
// Function('') while building object schemas, which the document policy refuses and reports; jitless keeps parsing identical
// without the probe. The server keeps the JIT (no policy applies there).
if (typeof window !== 'undefined') z.config({ jitless: true });
