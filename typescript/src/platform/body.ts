import { problem } from "./errors"

/** Reads a JSON body as a record, or answers 400. */
export const asRecord = (raw: unknown): Record<string, unknown> => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw problem(400, "BAD_BODY", "the body must be an object")
    return raw as Record<string, unknown>
}

/** A required non-empty string field (at most 200 characters), or 400. */
export const text = (body: Record<string, unknown>, name: string): string => {
    const value = body[name]
    if (typeof value !== "string" || value.trim() === "" || value.length > 200)
        throw problem(400, "BAD_FIELD", `${name} must be a non-empty string`)
    return value
}

/** A required positive integer field, or 400. */
export const positiveInt = (body: Record<string, unknown>, name: string): number => {
    const value = body[name]
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
        throw problem(400, "BAD_FIELD", `${name} must be a positive integer`)
    return value
}

/** The `Idempotency-Key` header, or null when the caller sent none. A key is bounded so the table stays small and indexable. */
export const keyOf = (header: string | undefined): string | null => {
    if (header === undefined || header.trim() === "") return null
    if (header.length > 200) throw problem(400, "BAD_KEY", "Idempotency-Key is longer than 200 characters")
    return header.trim()
}
