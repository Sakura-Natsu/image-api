import { createHash, timingSafeEqual } from "node:crypto";

export function safeEqual(a, b) {
  const bufA = createHash("sha256").update(String(a ?? "")).digest();
  const bufB = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(bufA, bufB);
}
