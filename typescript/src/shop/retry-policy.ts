/**
 * The shop's resend policy for one payment, as pure functions so the unit specs can pin them down.
 *
 * A caller that never resends loses orders whenever the network blips before the charge; a caller that resends must send the
 * SAME key every time, so the receiving side can tell a resend from a new payment. This policy is the caller's half of that deal.
 */
export interface RetryPolicy {
    /** How long one attempt waits for an answer (read timeout). */
    readonly readTimeoutMs: number
    /** How many attempts in total, the first included. */
    readonly maxAttempts: number
    /** The first pause; each later pause doubles. */
    readonly backoffBaseMs: number
    /** The whole payment is given up after this long (its deadline). */
    readonly deadlineMs: number
}

export const DEFAULT_POLICY: RetryPolicy = { readTimeoutMs: 1_000, maxAttempts: 4, backoffBaseMs: 1_000, deadlineMs: 120_000 }

/**
 * Whether an answer is final. No answer (status 0), any 5xx and `409 IN_PROGRESS` are not: the outcome is unknown or still being
 * made, so the same request is sent again. Every other answer (201, 402, 422...) is final and is never resent.
 */
export const isFinal = (status: number, body: unknown): boolean => {
    if (status === 0 || status >= 500) return false
    const inProgress = status === 409 && typeof body === "object" && body !== null && "error" in body && body.error === "IN_PROGRESS"
    return !inProgress
}

/**
 * The pause before attempt `attempt + 1`: exponential backoff (base, 2x base, 4x base...) plus up to a quarter of the base as
 * jitter, so many shops that failed together do not all resend in the same millisecond.
 */
export const backoffMs = (policy: RetryPolicy, attempt: number, random: () => number = Math.random): number =>
    policy.backoffBaseMs * 2 ** (attempt - 1) + Math.floor(random() * (policy.backoffBaseMs / 4))
