import { Injectable } from "@nestjs/common"
import { Database, type Tx } from "../database"
import { FaultsService } from "../faults"
import { fingerprintOf } from "./fingerprint"

/** The key table every service that takes an `Idempotency-Key` creates. One row per (operation, key). */
export const IDEMPOTENCY_SCHEMA = `
    CREATE TABLE IF NOT EXISTS idempotency_keys (
        operation     text        NOT NULL,
        key           text        NOT NULL,
        fingerprint   text        NOT NULL,
        status        text        NOT NULL CHECK (status IN ('processing', 'done')),
        response_code integer,
        response_body jsonb,
        created_at    timestamptz NOT NULL,
        PRIMARY KEY (operation, key)
    )`

/** How long a key is kept: far longer than any caller keeps resending (the shop gives up after 2 minutes). */
export const KEY_RETENTION_MS = 24 * 60 * 60 * 1000

/** The final answer of an operation, stored under its key and sent back unchanged to every resend. */
export interface Outcome {
    readonly status: number
    readonly body: unknown
}

/** What a caller gets: the outcome, and whether it is the stored outcome of an earlier request (`Idempotent-Replayed`). */
export interface KeyedOutcome extends Outcome {
    readonly replayed: boolean
}

/** One request carrying an `Idempotency-Key`. */
export interface KeyedRequest {
    /** The operation the key belongs to (`payments.charge`): the same key for two operations is two keys. */
    readonly operation: string
    /** The caller's key, or null when it sent none (then nothing protects a resend). */
    readonly key: string | null
    readonly method: string
    readonly path: string
    readonly body: unknown
}

@Injectable()
/**
 * Runs an effectful operation at most once per key and replays its outcome.
 *
 * Everything happens in ONE transaction of the service's own database: forget expired keys, claim the key, run the effect, store
 * the outcome. So the claim, the effect and the stored answer commit or roll back together:
 *   - a resend after the commit finds the stored outcome and gets it back, with `replayed: true`;
 *   - a second request arriving while the first is still open waits on the primary key until the first ends, then replays;
 *   - a crash, a lost database reply or any thrown error rolls everything back, the key included, so the resend runs once;
 *   - a final refusal (402) is an outcome like a success: stored, and replayed to every resend;
 *   - the same key with a different request is refused with 422 `KEY_REUSED`, never answered with someone else's outcome;
 *   - keys older than 24 hours are deleted on the way in, so a day-old key is a new request and the table never grows forever.
 */
export class IdempotencyStore {
    constructor(
        private readonly db: Database,
        private readonly faults: FaultsService,
    ) {}

    readonly run = async (request: KeyedRequest, effect: (tx: Tx) => Promise<Outcome>): Promise<KeyedOutcome> => {
        if (request.key === null) return { ...(await this.db.transaction(effect)), replayed: false }
        const key = request.key
        const fingerprint = fingerprintOf(request)
        return this.db.transaction(async (tx): Promise<KeyedOutcome> => {
            await tx.query(`DELETE FROM idempotency_keys WHERE created_at < $1`, [new Date(this.faults.now().getTime() - KEY_RETENTION_MS)])

            const claimed = await this.faults.runStep("claim", () =>
                tx.query(
                    `INSERT INTO idempotency_keys (operation, key, fingerprint, status, created_at) VALUES ($1, $2, $3, 'processing', $4)
                     ON CONFLICT (operation, key) DO NOTHING`,
                    [request.operation, key, fingerprint, this.faults.now()],
                ),
            )
            if (claimed.rowCount !== 1) return this.existing(tx, request.operation, key, fingerprint)

            const outcome = await effect(tx)
            await this.faults.runStep("answer", () =>
                tx.query(
                    `UPDATE idempotency_keys SET status = 'done', response_code = $3, response_body = $4 WHERE operation = $1 AND key = $2`,
                    [request.operation, key, outcome.status, JSON.stringify(outcome.body)],
                ),
            )
            return { ...outcome, replayed: false }
        })
    }

    /** The answer for a key some earlier request already claimed. */
    private readonly existing = async (tx: Tx, operation: string, key: string, fingerprint: string): Promise<KeyedOutcome> => {
        const rows = await tx.query<{ fingerprint: string; status: string; response_code: number | null; response_body: unknown }>(
            `SELECT fingerprint, status, response_code, response_body FROM idempotency_keys WHERE operation = $1 AND key = $2`,
            [operation, key],
        )
        const row = rows.rows[0]
        if (row !== undefined && row.fingerprint !== fingerprint)
            return { status: 422, body: { error: "KEY_REUSED", message: "this key was used for a different request" }, replayed: false }
        if (row !== undefined && row.status === "done" && row.response_code !== null)
            return { status: row.response_code, body: row.response_body, replayed: true }
        // Claimed and committed without an outcome cannot happen here (the claim and the outcome commit together); answer
        // "in progress" so a caller resends later rather than charging twice.
        return { status: 409, body: { error: "IN_PROGRESS", message: "a request with this key is still running" }, replayed: false }
    }
}
