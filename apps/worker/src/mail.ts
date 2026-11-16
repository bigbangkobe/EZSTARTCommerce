import nodemailer from 'nodemailer';

export type MailKind = 'invitation' | 'password_reset';
export interface NotificationMail {
  id: string;
  kind: MailKind;
  to: string;
  locale: string;
  link: string;
  expiresAt: Date;
}
export interface MailSender { send(mail: NotificationMail): Promise<void> }
export function mailConfig(env: NodeJS.ProcessEnv) {
  const host = env['SMTP_HOST']; const user = env['SMTP_USER']; const pass = env['SMTP_PASSWORD']; const from = env['SMTP_FROM'];
  const port = Number(env['SMTP_PORT'] ?? '587');
  if (!host || /[\s/]/.test(host) || !user || !pass || !from || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP configuration');
  return { host, port, from, secure: port === 465, auth: { user, pass } };
}
const copy: Record<MailKind, Record<string, [subject: string, introduction: string]>> = {
  invitation: {
    en: ['Your store staff invitation', 'Open this link to set your password and enroll your authenticator.'],
    'zh-CN': ['店铺员工邀请', '请打开以下链接，设置密码并绑定验证器。'],
    'zh-HK': ['店舖員工邀請', '請開啟以下連結，設定密碼並綁定驗證器。'],
  },
  password_reset: {
    en: ['Reset your store password', 'Open this link to choose a new password. Every existing session will be signed out.'],
    'zh-CN': ['重设店铺后台密码', '请打开以下链接设置新密码；完成后所有已登录会话将被退出。'],
    'zh-HK': ['重設店舖後台密碼', '請開啟以下連結設定新密碼；完成後所有已登入工作階段將被登出。'],
  },
};
export class SmtpMailSender implements MailSender {
  private readonly transport;
  private readonly from: string;
  constructor(config: ReturnType<typeof mailConfig>) {
    this.from = config.from;
    this.transport = nodemailer.createTransport({ ...config, requireTLS: true,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true }, disableFileAccess: true, disableUrlAccess: true });
  }
  async send(mail: NotificationMail) {
    const [subject, introduction] = copy[mail.kind][mail.locale] ?? copy[mail.kind]['en']!;
    const tag = mail.kind === 'invitation' ? 'invitation' : 'password-reset';
    const result = await this.transport.sendMail({ from: this.from, to: mail.to,
      messageId: `<${tag}-${mail.id}@${this.from.split('@')[1]}>`, subject,
      text: `${introduction}\n\n${mail.link}\n\nExpires (UTC): ${mail.expiresAt.toISOString()}` });
    if (!result.accepted?.length || result.rejected?.length) throw new Error('SMTP_NOT_ACCEPTED');
  }
}
