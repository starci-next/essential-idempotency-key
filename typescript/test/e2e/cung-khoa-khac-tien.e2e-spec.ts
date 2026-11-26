// U3 · Cùng khóa, khác tiền: sau câu trả lời đầu, bên gọi gửi thêm một lần cùng khóa mà số tiền đã tăng 50.000đ.
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
    world,
    type Attempt,
    type World,
} from "./lab"

const CASE = "cung-khoa-khac-tien"
let first: Attempt | undefined
let reused: Attempt | undefined
let now: World
beforeAll(async () => {
    await resetLab()
    await setChaos({ REUSE_KEY: "amount=+50000" })
    await checkout(ORDER)
    const attempts = await attemptsOf(ORDER.orderId)
    first = attempts.find((item) => item.kind === "send")
    reused = attempts.find((item) => item.kind === "reuse")
    now = await world(ORDER)
})
afterAll(closeDb)

check(CASE, "reused-key-refused", "cùng khóa mà khác nội dung thì nhận 422 KEY_REUSED", () => {
    holds(reused !== undefined, "reused-key-refused", "không thấy lần gửi cùng khóa khác tiền trong nhật ký gửi của shop")
    holds(
        reused?.status === 422 && reused.body?.error === "KEY_REUSED",
        "reused-key-refused",
        `gửi ${reused?.amount}đ với khóa của lần ${first?.amount}đ, payments trả ${reused?.status} ${JSON.stringify(reused?.body)}; cần 422 KEY_REUSED`,
    )
})

checkChargedOnce(CASE, () => ({ now, start: WALLET, order: ORDER }))

check(CASE, "no-borrowed-answer", "câu trả lời đã lưu không bị trả cho một nội dung khác", () => {
    holds(
        !sameBody(reused?.body, first?.body),
        "no-borrowed-answer",
        `yêu cầu ${reused?.amount}đ nhận lại đúng câu trả lời của yêu cầu ${first?.amount}đ: ${JSON.stringify(reused?.body)}`,
    )
})
