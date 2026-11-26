import { createHash } from "node:crypto"

/** JSON with object keys sorted, so `{a, b}` and `{b, a}` produce the same text. */
export const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
    if (typeof value === "object" && value !== null)
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
            .join(",")}}`
    return JSON.stringify(value) ?? "null"
}

/**
 * The fingerprint of a request: a hash of its method, path and canonical body. A key is bound to the fingerprint of the request
 * that claimed it; the same key with another fingerprint is a caller's mistake, never a resend.
 */
export const fingerprintOf = (request: { method: string; path: string; body: unknown }): string =>
    createHash("sha256").update(`${request.method} ${request.path}\n${canonicalJson(request.body)}`).digest("hex")
