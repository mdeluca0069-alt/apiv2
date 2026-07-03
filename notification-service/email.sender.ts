/**
 * EmailSender — production-ready SMTP email delivery.
 * Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM env vars.
 * Without SMTP config: logs to console only (sandbox mode).
 */

export type EmailOptions = {
  userId?:  string;
  to?:      string;
  subject:  string;
  text:     string;
  html?:    string;
};

export class EmailSenderService {
  private readonly from: string;

  constructor() {
    this.from = process.env.SMTP_FROM ?? "noreply@igfxpro.com";
  }

  async send(opts: EmailOptions): Promise<boolean> {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT ?? "587");
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const to   = opts.to ?? `${opts.userId}@igfxpro.local`;

    if (!host || !user || !pass) {
      console.info(`[email][sandbox] to=${to} subject="${opts.subject}"`);
      return false;
    }

    try {
      // Dynamic import to avoid top-level dependency on nodemailer
      const nodemailer = await import("nodemailer");
      const transport  = nodemailer.createTransport({
        host, port, secure: port === 465,
        auth: { user, pass },
      });
      await transport.sendMail({
        from:    this.from,
        to,
        subject: opts.subject,
        text:    opts.text,
        html:    opts.html ?? `<p>${opts.text.replace(/\n/g, "<br>")}</p>`,
      });
      return true;
    } catch (err) {
      console.error(`[email] failed to ${to}:`, (err as Error).message);
      return false;
    }
  }
}

export const emailSender = new EmailSenderService();
export default emailSender;
