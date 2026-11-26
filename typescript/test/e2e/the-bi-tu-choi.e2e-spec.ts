// U4 · Bị từ chối rồi gửi lại: ví c-7 chỉ còn 1.000đ nên lần đầu bị từ chối (402); khách nạp thêm 5.000.000đ, shop gửi lại đúng
// khóa cũ. Rồi một chuyện khác: lần trừ tiền đầu gặp lỗi mất kết nối cơ sở dữ liệu trước khi ghi gì, shop gửi lại.
import { ORDER, WALLET, check, checkout, closeDb, holds, resetLab, sameBody, setChaos, show, vnd, world, type CheckoutBody, type Reply, type World } from "./lab"

const CASE = "the-bi-tu-choi"
const POOR = { orderId: "ord-007", customerId: "c-7", amount: 250_000 } as const
const POOR_START = 1_000
const TOPUP = 5_000_000
let refused: Reply<CheckoutBody>
let resent: Reply<CheckoutBody>
let afterTopup: World
let transient: Reply<CheckoutBody>
let afterTransient: World
beforeAll(async () => {
    await resetLab()
    await setChaos({ SEED_BALANCE: `${POOR.customerId}=${POOR_START}`, TOPUP_AFTER_FIRST: true })
    refused = await checkout(POOR)
    // Chờ khoản nạp thêm vào ví (nó chạy ngay sau câu trả lời đầu).
    await new Promise((resolve) => setTimeout(resolve, 300))
    resent = await checkout(POOR)
    afterTopup = await world(POOR)

    await resetLab()
    await setChaos({ TRANSIENT_ONCE: "debit" })
    transient = await checkout(ORDER)
    afterTransient = await world(ORDER)
})
afterAll(closeDb)

check(CASE, "refusal-kept", "gửi lại sau lời từ chối thì nhận đúng lời từ chối đó, không trừ tiền dù ví đã đủ", () => {
    holds(refused.body.payment?.code === 402, "refusal-kept", `lần đầu trả ${show(refused)}, cần payments trả 402`)
    holds(
        resent.body.payment?.code === 402 && sameBody(resent.body.payment.body, refused.body.payment?.body),
        "refusal-kept",
        `lần gửi lại sau khi nạp tiền trả ${show(resent)}; cần đúng câu 402 của lần đầu`,
    )
    holds(
        afterTopup.charges.length === 0 && afterTopup.wallet === POOR_START + TOPUP,
        "refusal-kept",
        `sổ trừ tiền có ${afterTopup.charges.length} lần, ví c-7 còn ${vnd(afterTopup.wallet)}; cần 0 lần và ${vnd(POOR_START + TOPUP)}`,
    )
})

check(CASE, "transient-runs-again", "lỗi tạm thời trước khi ghi gì thì lần gửi lại được làm thật: trừ một lần, trả 201", () => {
    holds(transient.status === 200 && transient.body.payment?.code === 201, "transient-runs-again", `thanh toán trả ${show(transient)}, cần 201`)
    holds(
        afterTransient.charges.length === 1 && afterTransient.wallet === WALLET - ORDER.amount,
        "transient-runs-again",
        `sổ trừ tiền có ${afterTransient.charges.length} lần, ví còn ${vnd(afterTransient.wallet)}; cần 1 lần và ${vnd(WALLET - ORDER.amount)}`,
    )
})
