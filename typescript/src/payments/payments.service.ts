import { Injectable } from "@nestjs/common"
import { Database, type Tx } from "../platform/database"
import { FaultsService } from "../platform/faults"
import { IDEMPOTENCY_SCHEMA, IdempotencyStore, type KeyedOutcome, type Outcome } from "../platform/idempotency/idempotency.store"

/** The payments database: wallets, the ledger of charges, and the key table. */
export const PAYMENTS_SCHEMA = [
    IDEMPOTENCY_SCHEMA,
    `CREATE TABLE IF NOT EXISTS wallets (
        customer_id text   PRIMARY KEY,
        balance     bigint NOT NULL CHECK (balance >= 0)
    )`,
    `CREATE TABLE IF NOT EXISTS charges (
        id          bigserial   PRIMARY KEY,
        order_id    text        NOT NULL,
        customer_id text        NOT NULL REFERENCES wallets (customer_id),
        amount      bigint      NOT NULL CHECK (amount > 0),
        created_at  timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS charges_order_id ON charges (order_id)`,
]

/** The sample wallet of the specs: 5,000,000 VND. */
export const SAMPLE_WALLET = { customerId: "c-minh", balance: 5_000_000 } as const

export interface ChargeInput {
    readonly orderId: string
    readonly customerId: string
    readonly amount: number
}

@Injectable()
/**
 * Charges a wallet at most once per `Idempotency-Key`. The debit, the ledger row and the stored answer are one transaction of the
 * payments database, run through the idempotency store.
 */
export class PaymentsService {
    constructor(
        private readonly db: Database,
        private readonly keys: IdempotencyStore,
        private readonly faults: FaultsService,
    ) {}

    readonly charge = (key: string | null, input: ChargeInput): Promise<KeyedOutcome> =>
        this.keys.run({ operation: "payments.charge", key, method: "POST", path: "/charges", body: input }, (tx) => this.debit(tx, input))

    /** The effect: debit the wallet if it holds enough, record the charge. An empty wallet is a final answer (402), not an error. */
    private readonly debit = async (tx: Tx, input: ChargeInput): Promise<Outcome> => {
        // The balance check and the debit are one statement: the wallet never goes below zero.
        const debited = await this.faults.runStep("debit", () =>
            tx.query(`UPDATE wallets SET balance = balance - $2 WHERE customer_id = $1 AND balance >= $2`, [input.customerId, input.amount]),
        )
        if (debited.rowCount !== 1) return { status: 402, body: { error: "INSUFFICIENT_FUNDS", message: `wallet ${input.customerId} cannot pay ${input.amount}` } }
        const inserted = await tx.query<{ id: string }>(`INSERT INTO charges (order_id, customer_id, amount) VALUES ($1, $2, $3) RETURNING id`, [
            input.orderId,
            input.customerId,
            input.amount,
        ])
        return { status: 201, body: { chargeId: `ch_${inserted.rows[0]?.id}`, orderId: input.orderId, amount: input.amount, status: "paid" } }
    }

    readonly balanceOf = async (customerId: string): Promise<{ customerId: string; balance: number } | null> => {
        const rows = await this.db.query<{ balance: string }>(`SELECT balance FROM wallets WHERE customer_id = $1`, [customerId])
        return rows[0] === undefined ? null : { customerId, balance: Number(rows[0].balance) }
    }

    readonly chargesOf = async (orderId: string): Promise<Array<{ chargeId: string; orderId: string; amount: number }>> =>
        (await this.db.query<{ id: string; amount: string }>(`SELECT id, amount FROM charges WHERE order_id = $1 ORDER BY id`, [orderId])).map(
            (row) => ({ chargeId: `ch_${row.id}`, orderId, amount: Number(row.amount) }),
        )

    readonly keyRow = async (key: string): Promise<Record<string, unknown> | null> => {
        const rows = await this.db.query<{ status: string; fingerprint: string; response_code: number | null; response_body: unknown; created_at: Date }>(
            `SELECT status, fingerprint, response_code, response_body, created_at FROM idempotency_keys WHERE key = $1`,
            [key],
        )
        const row = rows[0]
        if (row === undefined) return null
        return {
            key,
            status: row.status,
            fingerprint: row.fingerprint,
            answer: row.response_code === null ? null : { status: row.response_code, body: row.response_body },
            ageMinutes: Math.round((this.faults.now().getTime() - row.created_at.getTime()) / 60_000),
        }
    }

    readonly setBalance = async (customerId: string, balance: number): Promise<void> => {
        await this.db.query(
            `INSERT INTO wallets (customer_id, balance) VALUES ($1, $2) ON CONFLICT (customer_id) DO UPDATE SET balance = $2`,
            [customerId, balance],
        )
    }

    readonly topUp = async (customerId: string, amount: number): Promise<void> => {
        await this.db.query(`UPDATE wallets SET balance = balance + $2 WHERE customer_id = $1`, [customerId, amount])
    }

    /** Puts the sample wallet back and forgets every charge and key. */
    readonly reset = async (): Promise<void> => {
        await this.db.transaction(async (tx) => {
            await tx.query(`TRUNCATE charges, idempotency_keys, wallets`)
            await tx.query(`INSERT INTO wallets (customer_id, balance) VALUES ($1, $2)`, [SAMPLE_WALLET.customerId, SAMPLE_WALLET.balance])
        })
    }

    /** Seeds the sample wallet on an empty database (a restart keeps the data). */
    readonly seedIfEmpty = async (): Promise<void> => {
        const rows = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM wallets`)
        if (rows[0]?.n === "0") await this.reset()
    }
}
