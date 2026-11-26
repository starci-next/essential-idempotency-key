// H2 · Hai đơn, hai khóa: anh Minh trả tiền hai đơn khác nhau cùng lúc. Mỗi đơn có khóa riêng, nhận câu trả lời riêng.
import {
    ORDER,
    ORDER_2,
    WALLET,
    check,
    checkout,
    closeDb,
    holds,
    resetLab,
    show,
    vnd,
    world,
    type CheckoutBody,
    type OrderInput,
    type Reply,
    type World,
} from "./lab"

const CASE = "hai-don-hai-khoa"
let replies: Array<[OrderInput, Reply<CheckoutBody>]> = []
let worlds: Array<World> = []
beforeAll(async () => {
    await resetLab()
    const [first, second] = await Promise.all([checkout(ORDER), checkout(ORDER_2)])
    replies = [
        [ORDER, first],
        [ORDER_2, second],
    ]
    worlds = [await world(ORDER), await world(ORDER_2)]
})
afterAll(closeDb)

check(CASE, "paid", "cả hai đơn đều được trả 201 kèm mã thanh toán", () => {
    for (const [order, reply] of replies) {
        holds(reply.status === 200 && reply.body.payment?.code === 201, "paid", `đơn ${order.orderId} trả ${show(reply)}, cần 201`)
    }
})

check(CASE, "own-answer", "mỗi đơn nhận đúng câu trả lời của mình, không lẫn của đơn kia", () => {
    for (const [order, reply] of replies) {
        const body = reply.body.payment?.body as { orderId?: string; amount?: number } | undefined
        holds(
            body?.orderId === order.orderId && body.amount === order.amount,
            "own-answer",
            `đơn ${order.orderId} (${vnd(order.amount)}) nhận câu trả lời ${JSON.stringify(body)}`,
        )
    }
    const ids = replies.map(([, reply]) => (reply.body.payment?.body as { chargeId?: string } | undefined)?.chargeId)
    holds(ids[0] !== ids[1], "own-answer", `hai đơn nhận cùng một mã thanh toán ${ids[0]}`)
})

check(CASE, "charged-once", "mỗi đơn bị trừ đúng một lần, ví giảm đúng tổng hai đơn", () => {
    const wallet = worlds[1]?.wallet ?? NaN
    const expected = WALLET - ORDER.amount - ORDER_2.amount
    holds(
        worlds.every((each) => each.charges.length === 1) && wallet === expected,
        "charged-once",
        `sổ trừ tiền có ${worlds.map((each) => each.charges.length).join(" và ")} lần, ví còn ${vnd(wallet)}; cần 1 và 1, ví ${vnd(expected)}`,
    )
})
