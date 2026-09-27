import nodemailer, { type Transporter } from 'nodemailer';
import { badRequest } from '../errors';
import { getInfra } from '../infra';
import { getPlatformGroup } from './platform-settings.service';

/**
 * Outgoing email. Uses the SMTP server set in Platform admin → Email, else
 * SMTP_URL from the environment (EMAIL_DRIVER=smtp), else writes the email to
 * the log so development works without a mail server.
 */

export interface OutgoingEmail {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

let cached: { signature: string; transport: Transporter; from: string } | null = null;

async function transport(): Promise<{ transport: Transporter; from: string } | null> {
  const { env } = getInfra();
  const s = await getPlatformGroup('email');
  const company = await getPlatformGroup('company');
  let signature: string;
  let make: () => Transporter;
  let from: string;
  if (s.enabled && s.host && s.fromEmail) {
    signature = JSON.stringify([s.host, s.port, s.secure, s.user, s.password]);
    make = () => nodemailer.createTransport({ host: s.host!, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass: s.password ?? '' } : undefined, connectionTimeout: 15_000, greetingTimeout: 15_000 });
    from = `"${(s.fromName ?? company.productName).replace(/"/g, '')}" <${s.fromEmail}>`;
  } else if (env.EMAIL_DRIVER === 'smtp' && env.SMTP_URL) {
    signature = env.SMTP_URL;
    make = () => nodemailer.createTransport(env.SMTP_URL!);
    from = env.EMAIL_FROM;
  } else {
    return null;
  }
  if (!cached || cached.signature !== signature) cached = { signature, transport: make(), from };
  cached.from = from;
  return cached;
}

/** Whether real email delivery is configured. */
export async function emailConfigured(): Promise<boolean> {
  return (await transport()) !== null;
}

export async function sendEmail(email: OutgoingEmail): Promise<{ delivered: boolean }> {
  const { logger } = getInfra();
  const t = await transport();
  if (!t) {
    logger.info({ to: email.to, subject: email.subject, text: email.text }, 'email (not sent: no mail server configured)');
    return { delivered: false };
  }
  await t.transport.sendMail({ from: t.from, to: email.to, subject: email.subject, text: email.text, html: email.html ?? textToHtml(email.text), replyTo: email.replyTo });
  return { delivered: true };
}

/** Sends a test message with the saved settings; errors come back readable. */
export async function sendTestEmail(user: { isSuperAdmin: boolean }, to: string) {
  if (!user.isSuperAdmin) throw badRequest('Super admin only');
  if (!(await emailConfigured())) throw badRequest('Save and enable the SMTP settings first.');
  const company = await getPlatformGroup('company');
  try {
    await sendEmail({ to, subject: `${company.productName} test email`, text: `This is a test from ${company.productName}. If you can read it, email delivery works.` });
    return { ok: true };
  } catch (error) {
    throw badRequest(`Sending failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text to simple HTML: paragraphs, line breaks and clickable links. */
export function textToHtml(text: string): string {
  const body = text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>').replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`)
    .join('');
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1c2433">${body}</div>`;
}
