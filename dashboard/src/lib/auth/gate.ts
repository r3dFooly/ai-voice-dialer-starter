// Minimal admin gate for the standalone dashboard.
//
// A single shared password (DASHBOARD_ACCESS_PASSWORD) protects every admin
// view and server action. On sign-in we set an httpOnly cookie holding a token
// derived from the password (never the password itself); requireAdmin() /
// requireTab() verify that token in constant time and throw AuthError otherwise.
//
// This replaces the multi-role requireAdmin / requireTab the source app used.
// The exported call shape (async, throws on failure, returns an identity) is
// kept so pages and server actions can call it unchanged.

import { cookies } from "next/headers";
import { createHash, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE = "dashboard_auth";

export type Identity = { role: "admin" };

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "AuthError";
  }
}

function configuredPassword(): string {
  const pw = process.env.DASHBOARD_ACCESS_PASSWORD;
  if (!pw) throw new AuthError(500, "DASHBOARD_ACCESS_PASSWORD not configured");
  return pw;
}

/** Deterministic, non-reversible token for the auth cookie. */
export function tokenForPassword(password: string): string {
  return createHash("sha256").update(`dialer:${password}`).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** True when `password` matches DASHBOARD_ACCESS_PASSWORD. For a login action. */
export function verifyPassword(password: string): boolean {
  try {
    return constantTimeEqual(
      tokenForPassword(password),
      tokenForPassword(configuredPassword()),
    );
  } catch {
    return false;
  }
}

async function isAuthed(): Promise<boolean> {
  const store = await cookies();
  const token = store.get(AUTH_COOKIE)?.value;
  if (!token) return false;
  try {
    return constantTimeEqual(token, tokenForPassword(configuredPassword()));
  } catch {
    return false;
  }
}

/** Throws AuthError(401) unless the request carries a valid admin cookie. */
export async function requireAdmin(): Promise<Identity> {
  if (!(await isAuthed())) throw new AuthError(401, "unauthenticated");
  return { role: "admin" };
}

/** Tab-level gate. This build has a single admin role, so it is an alias of
 *  requireAdmin — the slug is accepted for call-site compatibility. */
export async function requireTab(_slug?: string): Promise<Identity> {
  return requireAdmin();
}
