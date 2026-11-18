const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function deriveKey(
  secret: string,
  purpose: "cookie-encryption" | "owner-session",
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  const params = {
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: encoder.encode(`wholefoods-mcp/${purpose}`),
  };
  return purpose === "cookie-encryption"
    ? crypto.subtle.deriveKey(params, material, { name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ])
    : crypto.subtle.deriveKey(params, material, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
      ]);
}

export async function encryptJson(secret: string, value: unknown): Promise<string> {
  const key = await deriveKey(secret, "cookie-encryption");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

export async function decryptJson(secret: string, sealed: string): Promise<unknown> {
  const [iv, ciphertext] = sealed.split(".");
  const key = await deriveKey(secret, "cookie-encryption");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlDecode(iv) },
    key,
    base64UrlDecode(ciphertext),
  );
  return JSON.parse(decoder.decode(plaintext));
}

export async function signOwnerSession(secret: string, expiresAt: number): Promise<string> {
  const key = await deriveKey(secret, "owner-session");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(expiresAt)));
  return `${expiresAt}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyOwnerSession(secret: string, token: string): Promise<boolean> {
  const [expiresAt, signature] = token.split(".");
  if (!expiresAt || !signature || Number(expiresAt) < Date.now()) return false;
  const key = await deriveKey(secret, "owner-session");
  return crypto.subtle.verify("HMAC", key, base64UrlDecode(signature), encoder.encode(expiresAt));
}

export async function passwordMatches(expected: string, given: string): Promise<boolean> {
  const [a, b] = await Promise.all(
    [expected, given].map((value) => crypto.subtle.digest("SHA-256", encoder.encode(value))),
  );
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  return left.reduce((difference, byte, index) => difference | (byte ^ right[index]), 0) === 0;
}
