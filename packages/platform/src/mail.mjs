import nodemailer from "nodemailer";
import { check } from "./security.mjs";

export function resetMailer(env = process.env) {
  if (!env.SMTP_HOST) return null;
  const port = Number(env.SMTP_PORT || 587);
  check(
    Number.isInteger(port) && port > 0 && port <= 65535,
    500,
    "Invalid SMTP_PORT",
  );
  check(
    env.SMTP_FROM && !/[\r\n]/.test(env.SMTP_FROM),
    500,
    "SMTP_FROM is required",
  );
  check(!env.SMTP_USER || env.SMTP_PASSWORD, 500, "SMTP_PASSWORD is required");
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: env.SMTP_USER
      ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD }
      : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return ({ to, url }) =>
    transport.sendMail({
      from: env.SMTP_FROM,
      to,
      subject: "MobileSci 密码重置",
      text: `你申请了 MobileSci 密码重置。请在 20 分钟内打开以下链接：\n\n${url}\n\n链接仅可使用一次。如果不是你本人申请，请忽略此邮件。`,
    });
}
