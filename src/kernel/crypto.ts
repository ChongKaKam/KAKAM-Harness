import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}
export async function checkPassword(password: string, value: string) {
  const [salt, hex] = value.split(':');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hex, 'hex');
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export class SecretVault {
  private key: Buffer;
  constructor(secret: string) {
    this.key = createHash('sha256').update(secret).digest();
  }
  encrypt(value: string) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const content = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), content].map((b) => b.toString('base64')).join('.');
  }
  decrypt(value: string) {
    const [iv, tag, content] = value.split('.').map((v) => Buffer.from(v, 'base64'));
    const c = createDecipheriv('aes-256-gcm', this.key, iv);
    c.setAuthTag(tag);
    return Buffer.concat([c.update(content), c.final()]).toString('utf8');
  }
}
