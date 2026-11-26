import { randomBytes } from "node:crypto"
import { Injectable } from "@nestjs/common"
import { Database } from "../platform/database"

/** The shop database: orders (each with the key of its payment) and the log of every attempt sent to payments. */
export const SHOP_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS orders (
        id          text        PRIMARY KEY,
        customer_id text        NOT NULL,
        amount      bigint      NOT NULL CHECK (amount > 0),
        payment_key text        NOT NULL,
        status      text        NOT NULL DEFAULT 'new',
        charge_id   text,
        updated_at  timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS attempts (
        id          bigserial   PRIMARY KEY,
        order_id    text        NOT NULL,
        payment_key text        NOT NULL,
        n           integer     NOT NULL,
        kind        text        NOT NULL,
        amount      bigint      NOT NULL,
        status      integer     NOT NULL,
        body        jsonb,
        replayed    boolean,
        delivered   boolean     NOT NULL,
        note        text,
        at          timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS attempts_order_id ON attempts (order_id)`,
]

export type OrderStatus = "new" | "paid" | "refused" | "failed" | "unknown"

export interface Order {
    readonly id: string
    readonly customerId: string
    readonly amount: number
    /** The key of this order's payment: made once when the order is born, sent with every attempt of its charge. */
    readonly paymentKey: string
    readonly status: OrderStatus
    readonly chargeId: string | null
}

/** One attempt the shop sent to payments, as the attempts log keeps it. */
export interface Attempt {
    readonly n: number
    /** "send": a normal attempt; "dup": the double click of DUP_AT; "reuse": the same key with a changed body (REUSE_KEY). */
    readonly kind: "send" | "dup" | "reuse"
    readonly paymentKey: string
    readonly amount: number
    /** The HTTP status payments answered; 0 when no answer came back. */
    readonly status: number
    readonly body: unknown
    readonly replayed: boolean | null
    /** False when the answer came but was dropped on the way back (DROP_RESPONSE). */
    readonly delivered: boolean
    readonly note: string | null
}

interface OrderRow {
    id: string
    customer_id: string
    amount: string
    payment_key: string
    status: OrderStatus
    charge_id: string | null
}

const toOrder = (row: OrderRow): Order => ({
    id: row.id,
    customerId: row.customer_id,
    amount: Number(row.amount),
    paymentKey: row.payment_key,
    status: row.status,
    chargeId: row.charge_id,
})

/** A fresh payment key: a long random string, so two payments never share a key. */
const newPaymentKey = (): string => `pay_${randomBytes(16).toString("hex")}`

@Injectable()
export class OrdersService {
    constructor(private readonly db: Database) {}

    /** Gets the order, or creates it with a fresh key. Paying an existing order again resends the same payment, with its old key. */
    readonly open = async (input: { orderId: string; customerId: string; amount: number }): Promise<Order> => {
        await this.db.query(`INSERT INTO orders (id, customer_id, amount, payment_key) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, [
            input.orderId,
            input.customerId,
            input.amount,
            newPaymentKey(),
        ])
        const found = await this.find(input.orderId)
        if (found === null) throw new Error(`order ${input.orderId} vanished right after it was created`)
        return found
    }

    readonly find = async (orderId: string): Promise<Order | null> => {
        const rows = await this.db.query<OrderRow>(`SELECT * FROM orders WHERE id = $1`, [orderId])
        return rows[0] === undefined ? null : toOrder(rows[0])
    }

    readonly finish = async (orderId: string, status: OrderStatus, chargeId: string | null): Promise<void> => {
        await this.db.query(`UPDATE orders SET status = $2, charge_id = coalesce($3, charge_id), updated_at = now() WHERE id = $1`, [
            orderId,
            status,
            chargeId,
        ])
    }

    readonly record = async (orderId: string, attempt: Attempt): Promise<void> => {
        await this.db.query(
            `INSERT INTO attempts (order_id, payment_key, n, kind, amount, status, body, replayed, delivered, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [orderId, attempt.paymentKey, attempt.n, attempt.kind, attempt.amount, attempt.status, JSON.stringify(attempt.body ?? null), attempt.replayed, attempt.delivered, attempt.note],
        )
    }

    readonly attempts = async (orderId: string): Promise<Array<Attempt>> =>
        (
            await this.db.query<{ n: number; kind: Attempt["kind"]; payment_key: string; amount: string; status: number; body: unknown; replayed: boolean | null; delivered: boolean; note: string | null }>(
                `SELECT * FROM attempts WHERE order_id = $1 ORDER BY id`,
                [orderId],
            )
        ).map((row) => ({
            n: row.n,
            kind: row.kind,
            paymentKey: row.payment_key,
            amount: Number(row.amount),
            status: row.status,
            body: row.body,
            replayed: row.replayed,
            delivered: row.delivered,
            note: row.note,
        }))

    readonly reset = async (): Promise<void> => {
        await this.db.query(`TRUNCATE orders, attempts`)
    }
}
