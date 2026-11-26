import {
    Body,
    Controller,
    Get,
    Headers,
    Injectable,
    Module,
    NotFoundException,
    type OnApplicationBootstrap,
    Param,
    Post,
    Query,
    Res,
} from "@nestjs/common"
import type { Response } from "express"
import { asRecord, keyOf, positiveInt, text } from "../platform/body"
import { problem } from "../platform/errors"
import { FAULT_HOOK, type FaultHook, type Faults, FaultsService } from "../platform/faults"
import { IdempotencyStore } from "../platform/idempotency/idempotency.store"
import { SEEDER, type Seeder, ServiceModule, requireHooks } from "../platform/service.module"
import { PAYMENTS_SCHEMA, PaymentsService } from "./payments.service"

/** TOPUP_AFTER_FIRST adds this much to the wallet right after the first answer. */
const TOPUP_AMOUNT = 5_000_000

@Controller()
/** The payments door: `POST /charges` honours `Idempotency-Key` and says in `Idempotent-Replayed` whether the answer is stored. */
export class PaymentsController {
    constructor(
        private readonly payments: PaymentsService,
        private readonly faults: FaultsService,
    ) {}

    @Post("charges")
    async charge(@Body() raw: unknown, @Headers("idempotency-key") header: string | undefined, @Res() res: Response): Promise<void> {
        const body = asRecord(raw)
        const input = { orderId: text(body, "orderId"), customerId: text(body, "customerId"), amount: positiveInt(body, "amount") }
        const key = keyOf(header)
        if (this.faults.takeOnce("TOPUP_AFTER_FIRST")) {
            res.on("finish", () => void this.payments.topUp(input.customerId, TOPUP_AMOUNT))
        }
        const outcome = await this.payments.charge(key, input)
        res.set("idempotent-replayed", String(outcome.replayed)).status(outcome.status).json(outcome.body)
    }

    @Get("wallets/:customerId")
    async wallet(@Param("customerId") customerId: string): Promise<{ customerId: string; balance: number }> {
        const found = await this.payments.balanceOf(customerId)
        if (found === null) throw problem(404, "WALLET_NOT_FOUND", "no such wallet")
        return found
    }

    @Get("lab/charges")
    charges(@Query("orderId") orderId: string | undefined): Promise<Array<{ chargeId: string; orderId: string; amount: number }>> {
        requireHooks()
        return this.payments.chargesOf(orderId ?? "")
    }

    @Get("lab/keys/:key")
    async key(@Param("key") key: string): Promise<Record<string, unknown>> {
        requireHooks()
        const row = await this.payments.keyRow(key)
        if (row === null) throw new NotFoundException({ error: "KEY_NOT_FOUND", message: "no such key" })
        return row
    }
}

@Injectable()
class PaymentsSeeder implements Seeder, FaultHook, OnApplicationBootstrap {
    constructor(private readonly payments: PaymentsService) {}

    reset(): Promise<void> {
        return this.payments.reset()
    }

    onApplicationBootstrap(): Promise<void> {
        return this.payments.seedIfEmpty()
    }

    /** SEED_BALANCE="c-7=1000" sets that wallet the moment the switch is set. */
    async applied(patch: Faults): Promise<void> {
        if (patch.SEED_BALANCE === undefined) return
        const [customerId, balance] = String(patch.SEED_BALANCE).split("=").map((part) => part.trim())
        if (customerId === undefined || customerId === "" || !Number.isSafeInteger(Number(balance)))
            throw problem(400, "BAD_CHAOS", `SEED_BALANCE must look like "c-7=1000"`)
        await this.payments.setBalance(customerId, Number(balance))
    }
}

@Module({
    imports: [ServiceModule.forService("payments", PAYMENTS_SCHEMA)],
    controllers: [PaymentsController],
    providers: [
        PaymentsService,
        IdempotencyStore,
        PaymentsSeeder,
        { provide: SEEDER, useExisting: PaymentsSeeder },
        { provide: FAULT_HOOK, useExisting: PaymentsSeeder },
    ],
})
export class PaymentsModule {}
