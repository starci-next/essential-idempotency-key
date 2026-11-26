import { HttpException } from "@nestjs/common"

/**
 * A final business answer: an HTTP status plus `{ error, message }`, where `error` is a stable machine code
 * (`INSUFFICIENT_FUNDS`). Sending the same request again gets the same answer.
 */
export const problem = (status: number, code: string, message: string): HttpException => new HttpException({ error: code, message }, status)

/**
 * A transient failure between a service and its database (the connection dropped, the reply never came). Nothing the caller
 * can see was decided, so the service answers 503 and the caller sends the same request, with the same key, again.
 */
export class TransientStoreError extends Error {
    readonly step: string

    constructor(step: string, message: string) {
        super(message)
        this.name = "TransientStoreError"
        this.step = step
    }
}

/** Postgres and Node codes that mean the connection to the database broke: transient, a resend is safe. */
const CONNECTION_LOST = new Set(["ECONNRESET", "ECONNREFUSED", "57P01", "57P03", "08000", "08003", "08006"])

export const isTransient = (error: unknown): boolean =>
    error instanceof TransientStoreError ||
    (typeof error === "object" && error !== null && "code" in error && CONNECTION_LOST.has(String(error.code)))
