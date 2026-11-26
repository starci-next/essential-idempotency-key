// H1 · Một lần thanh toán, một khóa: anh Minh trả tiền một đơn, mạng êm, không ai gửi lại.
import { ORDER, WALLET, check, checkChargedOnce, checkout, closeDb, holds, resetLab, show, world, type CheckoutBody, type Reply, type World } from "./lab"

const CASE = "mot-lan-tra-tien"
let reply: Reply<CheckoutBody>
let now: World
beforeAll(async () => {
    await resetLab()
    reply = await checkout(ORDER)
    now = await world(ORDER)
})
afterAll(closeDb)

check(CASE, "paid", "payments trả 201 kèm mã thanh toán", () => {
    const body = reply.body.payment?.body as { chargeId?: string } | undefined
    holds(
        reply.status === 200 && reply.body.payment?.code === 201 && typeof body?.chargeId === "string",
        "paid",
        `thanh toán trả ${show(reply)}, cần payments trả 201 kèm chargeId`,
    )
})

checkChargedOnce(CASE, () => ({ now, start: WALLET, order: ORDER }))
