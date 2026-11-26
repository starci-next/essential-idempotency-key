import { Injectable, Logger } from "@nestjs/common"
import { TransientStoreError } from "./errors"

/**
 * Fault switches for the end-to-end specs. They live in the infrastructure (the shop's payments client and the payments steps),
 * never in the charge logic: the logic must survive these faults without knowing they are simulated. They are reachable only
 * when the process runs with `TEST_HOOKS=on` (docker-compose.yml sets it; a production deployment does not).
 *
 * Shop side (the payments client):
 *   DROP_RESPONSE      the first N answers of payments are dropped on the way back: payments did the work, the shop never sees it
 *   DUP_AT             "charge": the shop sends the charge twice, 20 ms apart, same key, same body
 *   REUSE_KEY          "amount=+50000": after the first answer, the shop sends once more with the same key and a changed amount
 * Payments side (the named steps "claim", "debit", "answer"):
 *   DELAY_MS           the "debit" step waits N ms first; "claim:300" picks another step
 *   TRANSIENT_ONCE     the first run of the step fails with a lost database connection before anything is written
 *   LOST_REPLY         the first run of the step executes, but the database's reply never arrives
 *   CRASH_AFTER        the process exits right after the step, like a power cut (docker restarts it)
 *   CLOCK_SHIFT_HOURS  the service clock runs N hours ahead (key rows are stamped with this clock)
 *   SEED_BALANCE       "c-7=1000": sets one wallet's balance now
 *   TOPUP_AFTER_FIRST  right after the first answer of POST /charges, the customer's wallet gets 5,000,000 more
 *
 * The switches live in the memory of one process, so a restart clears them: CRASH_AFTER kills a process exactly once.
 */
export const FAULT_KEYS = [
    "DROP_RESPONSE",
    "DUP_AT",
    "REUSE_KEY",
    "DELAY_MS",
    "TRANSIENT_ONCE",
    "LOST_REPLY",
    "CRASH_AFTER",
    "CLOCK_SHIFT_HOURS",
    "SEED_BALANCE",
    "TOPUP_AFTER_FIRST",
] as const
export type FaultKey = (typeof FAULT_KEYS)[number]
export type Faults = Partial<Record<FaultKey, string | number | boolean>>

const isFaultKey = (key: string): key is FaultKey => (FAULT_KEYS as ReadonlyArray<string>).includes(key)

const isOff = (value: unknown): boolean =>
    value === undefined || value === null || value === false || value === 0 || (typeof value === "string" && ["", "0", "off", "false"].includes(value.trim()))

/** Something a service does the moment a switch is set (payments sets SEED_BALANCE wallets). */
export interface FaultHook {
    applied(patch: Faults): Promise<void>
}
export const FAULT_HOOK = Symbol("FAULT_HOOK")

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

@Injectable()
export class FaultsService {
    private readonly logger = new Logger("faults")
    private state: Faults = {}
    private readonly transientDone = new Set<string>()
    private readonly lostDone = new Set<string>()
    private readonly used = new Set<FaultKey>()
    private dropped = 0

    readonly get = (): Faults => ({ ...this.state })

    /** Sets the named switches; an off value clears one. Setting switches starts a fresh attempt for the one-shot faults. */
    readonly set = (patch: Readonly<Record<string, unknown>>): Faults => {
        const applied: Faults = {}
        for (const [key, value] of Object.entries(patch)) {
            if (!isFaultKey(key)) continue
            if (isOff(value)) delete this.state[key]
            else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
                this.state[key] = value
                applied[key] = value
            }
        }
        this.clearCounters()
        return applied
    }

    readonly reset = (): void => {
        this.state = {}
        this.clearCounters()
    }

    readonly text = (key: FaultKey): string | null => (this.state[key] === undefined ? null : String(this.state[key]).trim())

    readonly number = (key: FaultKey): number => {
        const value = this.state[key]
        if (value === true) return 1
        const number = Number(value)
        return Number.isFinite(number) ? number : 0
    }

    readonly targets = (key: FaultKey, step: string): boolean =>
        (this.text(key) ?? "")
            .split(",")
            .map((name) => name.trim())
            .includes(step)

    /** True exactly once per setting of a one-shot switch (TOPUP_AFTER_FIRST, REUSE_KEY). */
    readonly takeOnce = (key: FaultKey): boolean => {
        if (this.state[key] === undefined || this.used.has(key)) return false
        this.used.add(key)
        return true
    }

    /** True while DROP_RESPONSE still has answers to drop (each true counts one dropped answer). */
    readonly takeDrop = (): boolean => {
        if (this.dropped >= this.number("DROP_RESPONSE")) return false
        this.dropped++
        return true
    }

    /** The service clock: real time plus CLOCK_SHIFT_HOURS. */
    readonly now = (): Date => new Date(Date.now() + this.number("CLOCK_SHIFT_HOURS") * 3_600_000)

    /** Runs one named payments step under the switches: delay, transient failure, the step, lost reply, crash. */
    readonly runStep = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
        const delay = this.delayOf(step)
        if (delay > 0) await sleep(delay)
        if (this.targets("TRANSIENT_ONCE", step) && !this.transientDone.has(step)) {
            this.transientDone.add(step)
            throw new TransientStoreError(step, "TRANSIENT_ONCE: the database connection dropped before the statement ran")
        }
        const result = await work()
        if (this.targets("LOST_REPLY", step) && !this.lostDone.has(step)) {
            this.lostDone.add(step)
            throw new TransientStoreError(step, "LOST_REPLY: the statement ran, its reply never arrived")
        }
        if (this.targets("CRASH_AFTER", step)) {
            this.logger.error(`CRASH_AFTER=${step}: exiting`)
            process.exit(1)
        }
        return result
    }

    private readonly delayOf = (step: string): number => {
        const value = this.text("DELAY_MS")
        if (value === null) return 0
        const [name, ms] = value.includes(":") ? value.split(":") : ["debit", value]
        return name?.trim() === step && Number(ms) > 0 ? Number(ms) : 0
    }

    private readonly clearCounters = (): void => {
        this.transientDone.clear()
        this.lostDone.clear()
        this.used.clear()
        this.dropped = 0
    }
}
