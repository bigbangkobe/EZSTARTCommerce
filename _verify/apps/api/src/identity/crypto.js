import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import * as OTPAuth from 'otpauth';
import { securityPolicy } from '../../../../packages/config/src/security-policy.js';
export function passwordHash(password) {
    return hash(password, { algorithm: 2 /* Algorithm.Argon2id */, memoryCost: 65_536, timeCost: 3, parallelism: 1, outputLen: 32 });
}
export function passwordMatches(hash, password) { return verify(hash, password).catch(() => false); }
export function token() { return randomBytes(securityPolicy.secretBytes).toString('base64url'); }
export function equal(left, right) {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}
export function encrypt(value, userId, config, purpose = 'totp') {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', config.encryptionKey, iv);
    cipher.setAAD(Buffer.from(`${config.instanceId}:${userId}:${purpose}`));
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function decrypt(value, userId, config, purpose = 'totp') {
    const data = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', config.encryptionKey, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${config.instanceId}:${userId}:${purpose}`));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
export function totp(secret, label) {
    return new OTPAuth.TOTP({ issuer: 'EZSTARTCommerce', label, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) });
}
export function newTotpSecret() { return new OTPAuth.Secret({ size: 20 }).base32; }
export function totpStep(secret, code, now) {
    if (!/^\d{6}$/.test(code))
        return null;
    const delta = totp(secret, '').validate({ token: code, timestamp: now.getTime(), window: 1 });
    return delta === null ? null : BigInt(Math.floor(now.getTime() / 30_000) + delta);
}
export function recoveryCodes() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const values = new Set();
    while (values.size < securityPolicy.recoveryCodeCount) {
        values.add([...randomBytes(securityPolicy.recoveryCodeCharacters)].map(byte => alphabet[byte & 31]).join(''));
    }
    return [...values];
}
export function csrf(sessionToken, config, purpose = 'totp') {
    return createHmac('sha256', config.encryptionKey).update(`${config.instanceId}:csrf:${sessionToken}`).digest('hex');
}
