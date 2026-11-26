// U1 · Mất câu trả lời: payments trừ tiền xong, câu trả lời rớt trên đường về, shop không nhận được nên gửi lại đúng yêu cầu cũ.
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
    story,
    world,
    type Attempt,
    type World,
} from "./lab"

const CASE = "mat-cau-tra-loi"
let attempts: Array<Attempt> = []
let now: World
beforeAll(async () => {
    await resetLab()
    await setChaos({ DROP_RESPONSE: 1 })
    await checkout(ORDER)
    attempts = (await attemptsOf(ORDER.orderId)).filter((item) => item.kind === "send")
    now = await world(ORDER)
})
afterAll(closeDb)

checkChargedOnce(CASE, () => ({ now, start: WALLET, order: ORDER }))

check(CASE, "same-answer", "lần gửi lại nhận đúng mã thanh toán, mã HTTP và nội dung của lần đầu", () => {
    const first = attempts[0]
    const resend = attempts.find((item) => item.delivered)
    holds(
        first !== undefined && resend !== undefined && resend !== first,
        "same-answer",
        `shop gửi: ${story(attempts)}; cần một lần đầu bị rớt và một lần gửi lại`,
    )
    holds(
        resend?.status === first?.status && sameBody(resend?.body, first?.body),
        "same-answer",
        `lần đầu payments trả ${first?.status} ${JSON.stringify(first?.body)}, lần gửi lại trả ${resend?.status} ${JSON.stringify(resend?.body)}`,
    )
})

check(CASE, "marked-replayed", "lần gửi lại có header Idempotent-Replayed: true", () => {
    const resend = attempts.find((item) => item.delivered)
    holds(resend?.replayed === true, "marked-replayed", `lần gửi lại có Idempotent-Replayed: ${String(resend?.replayed)}, cần true`)
})
