/**
 * Authentication primitives — password hashing and JWTs.
 *
 * Both are implemented with Node's built-in `crypto` so the project stays
 * dependency-free. This is the "JWT to start" path; swapping in Azure AD B2C
 * later only means replacing token verification in `rbac.ts`, not this file.
 *
 * Passwords are hashed with scrypt and stored as a self-describing string:
 *     scrypt$<N>$<saltHex>$<derivedHex>
 * so the cost parameter travels with the hash and can be raised over time.
 */
import crypto from 'crypto';
import { config } from './config';

// --- Password hashing (scrypt) ------------------------------------------------

const SCRYPT_N = 16384; // CPU/memory cost factor
const SCRYPT_KEYLEN = 64;

/** Hash a plaintext password into a storable `scrypt$...` string. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Verify a plaintext password against a stored `scrypt$...` string. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  const derived = crypto.scryptSync(password, salt, expected.length, { N: n });
  // Constant-time comparison to avoid leaking timing information.
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

// --- JSON Web Tokens (HS256) --------------------------------------------------

const TOKEN_TTL_SECONDS = 8 * 60 * 60; // 8 hours

export interface TokenPayload {
  sub: number; // user id
  email: string;
  role: string; // role code
  perms: string[]; // permission codes
  iat: number;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function sign(data: string): string {
  return base64url(crypto.createHmac('sha256', config.appSecret).update(data).digest());
}

/** Issue a signed JWT for an authenticated user. */
export function issueToken(
  payload: Omit<TokenPayload, 'iat' | 'exp'>,
  ttlSeconds: number = TOKEN_TTL_SECONDS,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const signature = sign(`${header}.${body}`);
  return `${header}.${body}.${signature}`;
}

/**
 * Verify a JWT and return its payload, or `null` if the token is malformed,
 * has a bad signature, or has expired.
 */
export function verifyToken(token: string): TokenPayload | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const [header, body, signature] = segments;

  const expectedSig = sign(`${header}.${body}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

// --- One-time tokens (password reset) ----------------------------------------

/** Generate a random opaque token and its SHA-256 hash (only the hash is stored). */
export function generateResetToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, tokenHash: hashToken(token) };
}

/** Hash a reset token for storage/lookup. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
