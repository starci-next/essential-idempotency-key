// U6 · Khóa quá hạn: shop thôi gửi lại sau 2 phút, payments giữ khóa 24 giờ. Đồng hồ của payments chạy nhanh lên 23 giờ, rồi 25 giờ.
import { ORDER, WALLET, chargeDirect, check, checkout, closeDb, holds, read, resetLab, sameBody, setChaos, show, vnd, world, type CheckoutBody, type Reply } from "./lab"

const CASE = "khoa-qua-han"
const LATE_AMOUNT = 1_250_000
let first: Reply<CheckoutBody>
let at23: Reply<CheckoutBody>
let chargesAt23 = 0
let at25: Reply<Record<string, unknown>>
let oldRows = 0
let walletAfter = 0
beforeAll(async () => {
    await resetLab()
    first = await checkout(ORDER)
    await setChaos({ CLOCK_SHIFT_HOURS: 23 })
    at23 = await checkout(ORDER)
    chargesAt23 = (await world(ORDER)).charges.length
    await setChaos({ CLOCK_SHIFT_HOURS: 25 })
    // Một bên gọi dùng lại khóa của hôm qua cho một yêu cầu khác: sau thời hạn giữ khóa, đó là một yêu cầu mới.
    at25 = await chargeDirect(first.body.paymentKey ?? "", { ...ORDER, amount: LATE_AMOUNT })
    // Dòng khóa tạo trước "bây giờ theo đồng hồ của payments trừ 24 giờ" (giờ thật + 25 giờ - 24 giờ) là dòng quá hạn.
    const [old] = await read<{ n: string }>("payments", "SELECT count(*) AS n FROM idempotency_keys WHERE created_at < now() + interval '1 hour'")
    oldRows = Number(old?.n ?? 0)
    walletAfter = (await world(ORDER)).wallet
})
afterAll(closeDb)

check(CASE, "resend-within-window", "23 giờ sau, gửi lại vẫn nhận câu trả lời đã lưu, không trừ thêm", () => {
    holds(
        at23.body.payment?.replayed === true &&
            sameBody(at23.body.payment.body, first.body.payment?.body) &&
            chargesAt23 === 1,
        "resend-within-window",
        `lần đầu ${show(first)}; 23 giờ sau ${show(at23)}, sổ trừ tiền có ${chargesAt23} lần; cần câu trả lời cũ, Idempotent-Replayed true, 1 lần trừ`,
    )
})

check(CASE, "old-key-is-new", "25 giờ sau, yêu cầu mang khóa cũ là yêu cầu mới: 201, Idempotent-Replayed: false", () => {
    holds(
        at25.status === 201 && at25.headers?.get("idempotent-replayed") === "false",
        "old-key-is-new",
        `25 giờ sau payments trả ${show(at25)} (Idempotent-Replayed: ${at25.headers?.get("idempotent-replayed")}); cần 201 và false`,
    )
    holds(walletAfter === WALLET - ORDER.amount - LATE_AMOUNT, "old-key-is-new", `ví còn ${vnd(walletAfter)}, cần ${vnd(WALLET - ORDER.amount - LATE_AMOUNT)}`)
})

check(CASE, "old-keys-gone", "sau một yêu cầu, không còn dòng khóa nào cũ hơn 24 giờ", () => {
    holds(oldRows === 0, "old-keys-gone", `bảng khóa còn ${oldRows} dòng cũ hơn 24 giờ`)
})
