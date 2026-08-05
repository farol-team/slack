import * as jose from "jose";
import { env } from "../lib/env";

const JWT_ALG = "HS256";

export type SessionPayload = {
  /** Internal users.id (serial PK). */
  userId: number;
};

export async function signSessionToken(
  payload: SessionPayload,
  expiresIn: string | number | Date = "1 year"
): Promise<string> {
  const secret = new TextEncoder().encode(env.appSecret);
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: JWT_ALG })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

export async function verifySessionToken(
  token: string
): Promise<SessionPayload | null> {
  if (!token) {
    console.warn("[session] No token provided for verification.");
    return null;
  }
  try {
    const secret = new TextEncoder().encode(env.appSecret);
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: [JWT_ALG],
    });
    if (typeof payload.userId !== "number") {
      console.warn("[session] JWT payload missing required fields.");
      return null;
    }
    return { userId: payload.userId };
  } catch (error) {
    console.warn("[session] JWT verification failed:", error);
    return null;
  }
}
