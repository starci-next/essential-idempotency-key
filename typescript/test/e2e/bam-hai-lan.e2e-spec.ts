// U2 · Bấm hai lần: hai yêu cầu cùng khóa, cùng nội dung, tới cách nhau 20 ms, lúc yêu cầu đầu còn đang trừ tiền (chậm 300 ms).
import {
    ORDER,
    WALLET,
    attemptsOf,
    check,
    checkChargedOnce,
    checkout,
    closeDb,
    holds,
    resetLab,
    sameBody,
    setChaos,
    show,
    world,
    type Attempt,
    type CheckoutBody,
    type Reply,
    type World,
} from "./lab"

const CASE = "bam-hai-lan"
let reply: Reply<CheckoutBody>
let first: Attempt | undefined
let second: Attempt | undefined
let now: World
beforeAll(async () => {
    await resetLab()
    await setChaos({ DUP_AT: "charge", DELAY_MS: 300 })
    reply = await checkout(ORDER)
    const attempts = await attemptsOf(ORDER.orderId)
    first = attempts.find((item) => item.kind === "send" && item.n === 1)
    second = attempts.find((item) => item.kind === "dup")
    now = await world(ORDER)
})
afterAll(closeDb)

checkChargedOnce(CASE, () => ({ now, start: WALLET, order: ORDER }))

check(CASE, "second-waits-or-replays", "yêu cầu thứ hai nhận câu trả lời của yêu cầu đầu, hoặc 409 IN_PROGRESS; không bao giờ 500", () => {
    holds(second !== undefined, "second-waits-or-replays", "không thấy yêu cầu thứ hai trong nhật ký gửi của shop")
    const inProgress = second?.status === 409 && second.body?.error === "IN_PROGRESS"
    const sameAnswer = second?.status === first?.status && sameBody(second?.body, first?.body)
    holds(
        inProgress || sameAnswer,
        "second-waits-or-replays",
        `yêu cầu đầu nhận ${first?.status} ${JSON.stringify(first?.body)}, yêu cầu thứ hai nhận ${second?.status} ${JSON.stringify(second?.body)}`,
    )
})

check(CASE, "shop-keeps-first", "shop kết thúc với câu trả lời của yêu cầu đầu", () => {
    holds(
        reply.status === 200 && sameBody(reply.body.payment?.body, first?.body),
        "shop-keeps-first",
        `shop trả ${show(reply)}, yêu cầu đầu nhận ${JSON.stringify(first?.body)}`,
    )
})
