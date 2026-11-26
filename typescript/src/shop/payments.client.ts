import { Injectable } from "@nestjs/common"
import { env, envNumber, sleep } from "../platform/env"
import { FaultsService } from "../platform/faults"
import { type Attempt, type Order, OrdersService } from "./orders.service"
import { type RetryPolicy, backoffMs, isFinal } from "./retry-policy"

/** The final answer the shop got for one payment; status 0 when it ran out of attempts without one. */
export interface PayOutcome {
    readonly status: number
    readonly body: unknown
    readonly replayed: boolean | null
    readonly attempts: number
}

/** DUP_AT sends its copy this long after the first attempt. */
const DUP_GAP_MS = 20

const parse = (text: string): unknown => {
    if (text === "") return null
    try {
        return JSON.parse(text) as unknown
    } catch {
        return text
    }
}

@Injectable()
/**
 * The shop's client for payments: every attempt of one payment carries the order's key in `Idempotency-Key`; an attempt with
 * no final answer is sent again after an exponential backoff with jitter, until the attempts or the deadline run out.
 */
export class PaymentsClient {
    private readonly baseUrl = env("PAYMENTS_URL")
    private readonly policy: RetryPolicy = {
        readTimeoutMs: envNumber("READ_TIMEOUT_MS", 1_000),
        maxAttempts: envNumber("MAX_ATTEMPTS", 4),
        backoffBaseMs: envNumber("BACKOFF_BASE_MS", 1_000),
        deadlineMs: envNumber("PAYMENT_DEADLINE_MS", 120_000),
    }

    constructor(
        private readonly orders: OrdersService,
        private readonly faults: FaultsService,
    ) {}

    readonly pay = async (order: Order): Promise<PayOutcome> => {
        const deadline = Date.now() + this.policy.deadlineMs
        for (let n = 1; n <= this.policy.maxAttempts; n++) {
            const dup = n === 1 && this.faults.targets("DUP_AT", "charge") ? sleep(DUP_GAP_MS).then(() => this.send(order, order.amount, "dup", n)) : null
            const sent = await this.send(order, order.amount, "send", n)
            if (dup !== null) await dup
            if (sent.delivered && isFinal(sent.status, sent.body)) {
                if (this.faults.takeOnce("REUSE_KEY")) await this.send(order, this.reusedAmount(order.amount), "reuse", n + 1)
                return { status: sent.status, body: sent.body, replayed: sent.replayed, attempts: n }
            }
            if (n === this.policy.maxAttempts) break
            const wait = backoffMs(this.policy, n)
            if (Date.now() + wait > deadline) break
            await sleep(wait)
        }
        return { status: 0, body: null, replayed: null, attempts: this.policy.maxAttempts }
    }

    /** One real attempt, written to the attempts log. Never throws: no answer is status 0. */
    private readonly send = async (order: Order, amount: number, kind: Attempt["kind"], n: number): Promise<Attempt> => {
        let attempt: Attempt = { n, kind, paymentKey: order.paymentKey, amount, status: 0, body: null, replayed: null, delivered: true, note: null }
        try {
            const response = await fetch(`${this.baseUrl}/charges`, {
                method: "POST",
                headers: { "content-type": "application/json", "idempotency-key": order.paymentKey },
                body: JSON.stringify({ orderId: order.id, customerId: order.customerId, amount }),
                signal: AbortSignal.timeout(this.policy.readTimeoutMs),
            })
            const replayed = response.headers.get("idempotent-replayed")
            attempt = { ...attempt, status: response.status, body: parse(await response.text()), replayed: replayed === null ? null : replayed === "true" }
            if (kind === "send" && this.faults.takeDrop()) attempt = { ...attempt, delivered: false, note: "DROP_RESPONSE: the answer was dropped on the way back" }
        } catch (error) {
            attempt = { ...attempt, note: `no answer: ${String(error)}` }
        }
        await this.orders.record(order.id, attempt)
        return attempt
    }

    private readonly reusedAmount = (amount: number): number => {
        const delta = Number(/amount=([+-]?\d+)/.exec(this.faults.text("REUSE_KEY") ?? "")?.[1] ?? "50000")
        return amount + (Number.isFinite(delta) && delta !== 0 ? delta : 50_000)
    }
}
