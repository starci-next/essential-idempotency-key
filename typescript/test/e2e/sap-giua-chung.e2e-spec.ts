// U5 · Sập giữa chừng: payments vừa trừ tiền thì chết, chưa kịp lưu câu trả lời. Docker bật nó lên lại; shop gửi lại khóa cũ.
import {
    ORDER,
    WALLET,
    attemptsOf,
    bootIdOf,
    check,
    checkChargedOnce,
    checkout,
    closeDb,
    holds,
    resetLab,
    setChaos,
    show,
    story,
    waitHealthy,
    world,
    type Attempt,
    type CheckoutBody,
    type Reply,
    type World,
} from "./lab"

const CASE = "sap-giua-chung"
let reply: Reply<CheckoutBody>
let attempts: Array<Attempt> = []
let now: World
let restarted = false
beforeAll(async () => {
    await resetLab()
    const bootBefore = await bootIdOf("payments")
    await setChaos({ CRASH_AFTER: "debit" })
    reply = await checkout(ORDER)
    await waitHealthy(90_000)
    restarted = (await bootIdOf("payments")) !== bootBefore
    attempts = await attemptsOf(ORDER.orderId)
    now = await world(ORDER)
})
afterAll(closeDb)

check(CASE, "final-after-crash", "sau khi payments bật lại, lần gửi lại nhận câu trả lời cuối cùng trong hạn của shop", () => {
    holds(restarted, "final-after-crash", "payments không chết và bật lại như sự cố đặt ra; xem docker compose logs payments")
    holds(
        reply.status === 200 && reply.body.payment?.code === 201,
        "final-after-crash",
        `shop gửi: ${story(attempts)}; thanh toán trả ${show(reply)}, cần 201`,
    )
})

checkChargedOnce(CASE, () => ({ now, start: WALLET, order: ORDER }))

check(CASE, "no-stuck-key", "không khóa nào còn “đang xử lý” khi yêu cầu của nó đã kết thúc", () => {
    holds(now.processingKeys === 0, "no-stuck-key", `bảng khóa còn ${now.processingKeys} khóa "processing"`)
})
