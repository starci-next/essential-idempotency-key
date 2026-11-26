import { Body, Controller, Get, Injectable, Module, Param, Post, Res } from "@nestjs/common"
import type { Response } from "express"
import { asRecord, positiveInt, text } from "../platform/body"
import { problem } from "../platform/errors"
import { SEEDER, type Seeder, ServiceModule, requireHooks } from "../platform/service.module"
import { type Attempt, type Order, type OrderStatus, OrdersService, SHOP_SCHEMA } from "./orders.service"
import { PaymentsClient } from "./payments.client"

const chargeIdOf = (body: unknown): string | null =>
    typeof body === "object" && body !== null && "chargeId" in body ? String(body.chargeId) : null

/** How the shop answers its customer for each final answer of payments. */
const verdictOf = (status: number): [OrderStatus, number] => {
    if (status === 201) return ["paid", 200]
    if (status === 402) return ["refused", 402]
    if (status === 0) return ["unknown", 504]
    return ["failed", 502]
}

@Controller()
/** The shop door: `POST /checkout` pays an order; paying the same order again resends the same payment with its old key. */
export class CheckoutController {
    constructor(
        private readonly orders: OrdersService,
        private readonly payments: PaymentsClient,
    ) {}

    @Post("checkout")
    async checkout(@Body() raw: unknown, @Res() res: Response): Promise<void> {
        const body = asRecord(raw)
        const order = await this.orders.open({ orderId: text(body, "orderId"), customerId: text(body, "customerId"), amount: positiveInt(body, "amount") })
        const outcome = await this.payments.pay(order)
        const [status, http] = verdictOf(outcome.status)
        await this.orders.finish(order.id, status, outcome.status === 201 ? chargeIdOf(outcome.body) : null)
        res.status(http).json({
            status,
            orderId: order.id,
            paymentKey: order.paymentKey,
            payment: { code: outcome.status, body: outcome.body, replayed: outcome.replayed, attempts: outcome.attempts },
        })
    }

    @Get("orders/:id")
    async order(@Param("id") id: string): Promise<Order> {
        const found = await this.orders.find(id)
        if (found === null) throw problem(404, "ORDER_NOT_FOUND", "no such order")
        return found
    }

    @Get("lab/attempts/:orderId")
    attempts(@Param("orderId") orderId: string): Promise<Array<Attempt>> {
        requireHooks()
        return this.orders.attempts(orderId)
    }
}

@Injectable()
class ShopSeeder implements Seeder {
    constructor(private readonly orders: OrdersService) {}

    reset(): Promise<void> {
        return this.orders.reset()
    }
}

@Module({
    imports: [ServiceModule.forService("shop", SHOP_SCHEMA)],
    controllers: [CheckoutController],
    providers: [OrdersService, PaymentsClient, ShopSeeder, { provide: SEEDER, useExisting: ShopSeeder }],
})
export class ShopModule {}
