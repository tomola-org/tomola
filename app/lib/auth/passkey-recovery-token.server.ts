import { createHmac } from "node:crypto";
import { authSecret } from "./secret.server";

export function recoveryToken(userId: string, id: number) {
  return createHmac("sha256", authSecret()).update(JSON.stringify(["passkey-recovery", userId, id])).digest("base64url");
}
