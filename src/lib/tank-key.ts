import crypto from "crypto";

// Tank keys: tk_ + 32 random hex chars
// Stored as SHA256 hash for verification

export function generateTankKey(): { raw: string; hash: string } {
  const raw = "tk_" + crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

export function hashKey(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function verifyKey(raw: string, hash: string): boolean {
  return hashKey(raw) === hash;
}

// Extract tank key from Authorization header
export function extractTankKey(authHeader?: string): string | null {
  if (!authHeader?.startsWith("Bearer tk_")) return null;
  return authHeader.slice(7);
}
