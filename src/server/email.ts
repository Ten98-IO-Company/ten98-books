import { Socket, isIP } from 'node:net';
import type { SendMailOptions } from 'nodemailer';
import { z } from 'zod';
import { environmentValue } from './config.ts';

const malformedUnicode = /[\uD800-\uDFFF]/u;
const mailbox = z.string().max(254).email(); // Exactly one bare mailbox; no names/lists/header syntax.
const messageInput = z.object({
  to: mailbox,
  subject: z.string().min(1).max(200).refine(v => !/[\p{C}\p{Zl}\p{Zp}]/u.test(v)),
  text: z.string().min(1).max(65_536).refine(v => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(v) && !malformedUnicode.test(v) && Buffer.byteLength(v, 'utf8') <= 65_536),
}).strict();
export type TransactionalEmail = z.infer<typeof messageInput>;
export type EmailAcceptance = { accepted: true; delivery: 'unconfirmed' };
export class EmailDeliveryError extends Error {
  readonly status = 503;
  constructor() { super('Email acceptance could not be confirmed. No automatic retry was made.'); this.name = 'EmailDeliveryError'; }
}

function configuration(env: NodeJS.ProcessEnv) {
  const transport = z.enum(['disabled', 'smtp']).parse(env.EMAIL_TRANSPORT || 'disabled');
  if (transport === 'disabled') return { transport };
  const from = mailbox.parse(environmentValue('EMAIL_FROM', env));
  const tls = z.enum(['starttls', 'tls']).parse(env.EMAIL_SMTP_TLS || 'starttls');
  const host = z.string().max(253).regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/).refine(v => !isIP(v)).parse(environmentValue('EMAIL_SMTP_HOST', env));
  const portText = z.string().regex(/^[1-9]\d{0,4}$/).parse(env.EMAIL_SMTP_PORT || (tls === 'tls' ? '465' : '587'));
  const port = z.number().int().min(1).max(65_535).parse(Number(portText));
  const user = z.string().min(1).max(256).refine(v => !/[\u0000-\u001f\u007f]/.test(v) && !malformedUnicode.test(v)).parse(environmentValue('EMAIL_SMTP_USER', env));
  const password = z.string().min(1).max(4096).refine(v => !/[\u0000\r\n]/.test(v) && !malformedUnicode.test(v)).parse(environmentValue('EMAIL_SMTP_PASSWORD', env));
  return { transport, from, host, port, tls, user, password };
}

/** Configuration only: does not contact a provider, verify entitlement or promise delivery. */
export function getEmailStatus(env: NodeJS.ProcessEnv = process.env): { configured: boolean; transport: 'disabled' | 'smtp' } {
  try { const config = configuration(env); return { configured: config.transport !== 'disabled', transport: config.transport }; }
  catch { return { configured: false, transport: 'disabled' }; }
}

type SmtpSender = { sendMail(message: SendMailOptions): Promise<unknown>; close(): void };

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener('abort', stop); reject(new EmailDeliveryError()); };
    if (signal.aborted) { work.catch(() => undefined); stop(); return; }
    signal.addEventListener('abort', stop, { once: true });
    work.then(value => { signal.removeEventListener('abort', stop); resolve(value); }, () => { signal.removeEventListener('abort', stop); reject(new EmailDeliveryError()); });
  });
}

/** One attempt, one recipient, bounded resources. Never logs messages, links or provider errors. */
export async function sendTransactionalEmail(input: TransactionalEmail, env: NodeJS.ProcessEnv = process.env): Promise<EmailAcceptance> {
  let config: ReturnType<typeof configuration>, message: TransactionalEmail;
  try { config = configuration(env); message = messageInput.parse(input); }
  catch { throw new EmailDeliveryError(); }
  if (config.transport === 'disabled') throw new EmailDeliveryError();
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
  const escaped = message.text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  const mail = { from: config.from, ...message, html: '<div>' + escaped.replace(/\r\n|\r|\n/g, '<br>') + '</div>' };
  try {
    const socket = new Socket(); let sender: SmtpSender | undefined;
    // destroy alone permits Socket reuse; refuse the mailer's late DNS callback on this owned instance.
    const stop = () => { socket.connect = () => { throw new EmailDeliveryError(); }; socket.destroy(); };
    controller.signal.addEventListener('abort', stop, { once: true });
    try {
      const { createTransport } = await untilAborted(import('nodemailer'), controller.signal);
      controller.signal.throwIfAborted();
      sender = createTransport({ socket, host: config.host, port: config.port, secure: config.tls === 'tls', requireTLS: true, opportunisticTLS: false, ignoreTLS: false, forceAuth: true,
        auth: { user: config.user, pass: config.password }, tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: config.host },
        connectionTimeout: 5000, greetingTimeout: 5000, dnsTimeout: 5000, socketTimeout: 10_000, maxResponseSize: 16_384,
        logger: false, debug: false, transactionLog: false, disableFileAccess: true, disableUrlAccess: true, maxRecipients: 1,
      });
      const result = z.object({ accepted: z.array(mailbox).length(1), rejected: z.array(z.unknown()).length(0), pending: z.array(z.unknown()).length(0).optional() }).parse(await untilAborted(sender.sendMail(mail), controller.signal));
      if (result.accepted[0] !== message.to) throw new EmailDeliveryError();
      return { accepted: true, delivery: 'unconfirmed' };
    } finally { controller.signal.removeEventListener('abort', stop); stop(); sender?.close(); }
  } catch { throw new EmailDeliveryError(); }
  finally { clearTimeout(timer); }
}
