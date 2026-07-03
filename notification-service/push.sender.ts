/**
 * PushSender — Web Push / FCM notification delivery.
 * Production: set PUSH_PROVIDER=fcm and FCM_SERVER_KEY env var.
 * Sandbox: logs to console only.
 */

export type PushOptions = {
  userId:  string;
  title:   string;
  body:    string;
  icon?:   string;
  url?:    string;
  payload?: Record<string, unknown>;
};

export class PushSenderService {

  async send(opts: PushOptions): Promise<boolean> {
    const provider = process.env.PUSH_PROVIDER?.toLowerCase();
    const fcmKey   = process.env.FCM_SERVER_KEY;

    if (provider !== "fcm" || !fcmKey) {
      console.info(`[push][sandbox] userId=${opts.userId} title="${opts.title}"`);
      return false;
    }

    try {
      const res = await fetch("https://fcm.googleapis.com/fcm/send", {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `key=${fcmKey}`,
        },
        body: JSON.stringify({
          to:           `/topics/user_${opts.userId}`,
          notification: { title: opts.title, body: opts.body, icon: opts.icon ?? "/icon.png" },
          data:         { url: opts.url, ...opts.payload },
        }),
      });
      return res.ok;
    } catch (err) {
      console.error(`[push] failed:`, (err as Error).message);
      return false;
    }
  }
}

export const pushSender = new PushSenderService();
export default pushSender;
