/**
 * SmsSender — SMS delivery via configurable provider.
 * Production: set SMS_PROVIDER=twilio and TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
 * Sandbox: logs to console only.
 */

export type SmsOptions = {
  to:   string;    // E.164 format: +1234567890
  body: string;
};

export class SmsSenderService {

  async send(opts: SmsOptions): Promise<boolean> {
    const provider = process.env.SMS_PROVIDER?.toLowerCase();
    const sid  = process.env.TWILIO_ACCOUNT_SID;
    const auth = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_FROM;

    if (provider !== "twilio" || !sid || !auth || !from) {
      console.info(`[sms][sandbox] to=${opts.to} body="${opts.body.slice(0, 80)}"`);
      return false;
    }

    try {
      const url  = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
      const body = new URLSearchParams({ To: opts.to, From: from, Body: opts.body });
      const res  = await fetch(url, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/x-www-form-urlencoded",
          "Authorization": `Basic ${Buffer.from(`${sid}:${auth}`).toString("base64")}`,
        },
        body: body.toString(),
      });
      return res.ok;
    } catch (err) {
      console.error(`[sms] failed:`, (err as Error).message);
      return false;
    }
  }
}

export const smsSender = new SmsSenderService();
export default smsSender;
