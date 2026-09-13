// API Key 静态加密：AES-256-GCM，密钥由服务端环境变量 NBA2K_EVAL_SECRET 派生
// （scrypt）。密文格式 base64(iv).base64(tag).base64(cipher)，仅服务端可解。
// 不写明文、不进日志；丢失 SECRET 将无法解密（评测可在无 Key 情况下回放）。

import "server-only";
import crypto from "node:crypto";

const SALT = "hardwood-gm-eval-v1";

function masterKey(): Buffer {
  const secret = process.env.NBA2K_EVAL_SECRET ?? `local-eval:${process.env.NBA2K_DB_PATH ?? "nba2k-gm.db"}`;
  return crypto.scryptSync(secret, SALT, 32);
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

export function encryptKey(key: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptKey(enc: string): string | null {
  try {
    const [ivB64, tagB64, dataB64] = enc.split(".");
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
