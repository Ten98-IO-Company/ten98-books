import { readResponseText } from '@ten98/runtime';

export class InputError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'InputError';
    this.status = status;
  }
}

export async function readJson(request: Request, maxBytes = 8192): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
  const type = request.headers.get('content-type');
  if (type === null || type.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new InputError(415, 'content-type must be application/json');
  }
  const length = request.headers.get('content-length');
  let text: string;
  try {
    // contentLength 'limit' refuses a malformed or oversize declaration before reading, without demanding an exact count.
    text = await readResponseText(new Response(request.body, length === null ? {} : { headers: { 'content-length': length } }), { maxBytes, contentLength: 'limit' });
  } catch (error) {
    // The runtime marks its byte limit with RESPONSE_TOO_LARGE, a malformed declaration with CONTENT_LENGTH_INVALID and
    // malformed UTF-8 with RESPONSE_DECODE_INVALID. Anything else, including an error raised by the body stream itself, is a read failure.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (error instanceof RangeError && code === 'RESPONSE_TOO_LARGE') throw new InputError(413, 'body too large');
    if (code === 'CONTENT_LENGTH_INVALID') throw new InputError(400, 'invalid content-length');
    if (code === 'RESPONSE_DECODE_INVALID') throw new InputError(400, 'body is not valid utf-8');
    throw new InputError(400, 'failed to read request body');
  }
  if (text.trim() === '') throw new InputError(400, 'empty body');
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError(400, 'body is not valid json');
  }
}
