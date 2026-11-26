// Công cụ chung cho các bài kiểm thử end-to-end: gọi shop và payments đang chạy (HTTP), đọc thẳng cơ sở dữ liệu, bật tắt sự cố.
// Phần kiểm thử không import code của dịch vụ: nó chỉ nhìn hệ thống từ bên ngoài, như khách hàng và như người đối soát sổ sách.
import { Pool } from "pg"

export type Service = "shop" | "payments"
export const SERVICES: ReadonlyArray<Service> = ["shop", "payments"]
const PORTS: Record<Service, number> = { shop: 4231, payments: 4232 }

/** Đơn của anh Minh: một đôi giày giá 1.200.000đ. Ví anh Minh có 5.000.000đ. */
export const ORDER = { orderId: "ord-001", customerId: "c-minh", amount: 1_200_000 } as const
/** Đơn thứ hai của anh Minh, giá khác, để thấy mỗi đơn nhận đúng câu trả lời của nó. */
export const ORDER_2 = { orderId: "ord-002", customerId: "c-minh", amount: 800_000 } as const
export const WALLET = 5_000_000

export interface OrderInput {
    orderId: string
    customerId: string
    amount: number
}

/** Địa chỉ của dịch vụ: `SHOP_URL`... nếu có, rồi tới `SHOP_PORT`... (cùng biến docker compose dùng), rồi cổng mặc định. */
export const urlOf = (service: Service): string => {
    const name = service.toUpperCase()
    return process.env[`${name}_URL`] ?? `http://localhost:${process.env[`${name}_PORT`] ?? PORTS[service]}`
}

export interface Reply<T> {
    /** Mã HTTP, hoặc 0 khi không có câu trả lời. */
    status: number
    body: T
    headers: Headers | null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Một lần gọi HTTP, không gửi lại: phần kiểm thử muốn thấy đúng điều đã xảy ra. */
export const call = async <T = unknown>(
    service: Service,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
): Promise<Reply<T>> => {
    try {
        const response = await fetch(`${urlOf(service)}${path}`, {
            method,
            headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(150_000),
        })
        const text = await response.text()
        let parsed: unknown = text
        try {
            parsed = text === "" ? null : JSON.parse(text)
        } catch {
            // Thân không phải JSON: giữ nguyên chuỗi.
        }
        return { status: response.status, body: parsed as T, headers: response.headers }
    } catch (error) {
        return { status: 0, body: String(error) as T, headers: null }
    }
}

/** Chờ cả hai dịch vụ trả lời `/health`. */
export const waitHealthy = async (timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    for (const service of SERVICES) {
        for (;;) {
            if ((await call(service, "GET", "/health")).status === 200) break
            if (Date.now() > deadline) throw new Error(`${service} không trả lời /health. Các dịch vụ đã chạy chưa? Chạy npm run up`)
            await sleep(250)
        }
    }
}

/** Về dữ liệu mẫu ở mọi dịch vụ (ví anh Minh 5.000.000đ, chưa có đơn, bảng khóa trống), mọi công tắc sự cố tắt. */
export const resetLab = async (): Promise<void> => {
    await waitHealthy()
    for (const service of SERVICES) {
        const reply = await call(service, "POST", "/lab/reset")
        if (reply.status !== 200) throw new Error(`${service} /lab/reset trả ${reply.status}: ${JSON.stringify(reply.body)}`)
    }
}

/** Bật công tắc sự cố ở mọi dịch vụ (chỉ có khi chạy với TEST_HOOKS=on). */
export const setChaos = async (patch: Record<string, string | number | boolean>): Promise<void> => {
    for (const service of SERVICES) {
        const reply = await call(service, "PUT", "/lab/chaos", patch)
        if (reply.status !== 200) throw new Error(`${service} /lab/chaos trả ${reply.status}: ${JSON.stringify(reply.body)}`)
    }
}

/** Câu trả lời của shop cho một lần thanh toán đơn. `payment` là câu trả lời cuối cùng shop nhận từ payments. */
export interface CheckoutBody {
    status?: "paid" | "refused" | "failed" | "unknown"
    orderId?: string
    paymentKey?: string
    payment?: { code: number; body: unknown; replayed: boolean | null; attempts: number }
}

/** Khách bấm "Thanh toán" cho một đơn (lần đầu, hoặc gửi lại cùng đơn đó: shop dùng lại khóa cũ của đơn). */
export const checkout = (order: OrderInput = ORDER): Promise<Reply<CheckoutBody>> => call<CheckoutBody>("shop", "POST", "/checkout", order)

/** Gọi thẳng payments với một khóa, như một bên gọi khác (không qua shop). */
export const chargeDirect = (key: string, body: OrderInput): Promise<Reply<Record<string, unknown>>> =>
    call<Record<string, unknown>>("payments", "POST", "/charges", body, { "idempotency-key": key })

export const bootIdOf = async (service: Service): Promise<string | null> => {
    const reply = await call<{ bootId?: string }>(service, "GET", "/health")
    return reply.status === 200 ? (reply.body.bootId ?? null) : null
}

// Đọc thẳng cơ sở dữ liệu của từng dịch vụ (chỉ đọc). Mặc định là Postgres của docker compose ở cổng 5452.
const pools = new Map<Service, Pool>()
const PG_BASE = process.env.LAB_PG_URL ?? `postgres://shop:shop@localhost:${process.env.PG_PORT ?? "5452"}`

const poolOf = (database: Service): Pool => {
    const existing = pools.get(database)
    if (existing !== undefined) return existing
    const pool = new Pool({ connectionString: `${PG_BASE}/${database}`, max: 2 })
    pools.set(database, pool)
    return pool
}

export const read = async <T extends object>(database: Service, sql: string, params: Array<unknown> = []): Promise<Array<T>> =>
    (await poolOf(database).query<T>(sql, params)).rows

export const closeDb = async (): Promise<void> => {
    await Promise.all([...pools.values()].map((pool) => pool.end()))
    pools.clear()
}

/** Một lần shop gửi lệnh trừ tiền, đọc từ nhật ký `attempts` của shop. */
export interface Attempt {
    n: number
    kind: "send" | "dup" | "reuse"
    amount: number
    status: number
    body: Record<string, unknown> | null
    replayed: boolean | null
    delivered: boolean
}

export const attemptsOf = async (orderId: string): Promise<Array<Attempt>> =>
    (
        await read<{ n: number; kind: Attempt["kind"]; amount: string; status: number; body: Record<string, unknown> | null; replayed: boolean | null; delivered: boolean }>(
            "shop",
            "SELECT n, kind, amount, status, body, replayed, delivered FROM attempts WHERE order_id = $1 ORDER BY id",
            [orderId],
        )
    ).map((row) => ({ ...row, amount: Number(row.amount) }))

/** Ảnh chụp sổ sách của một đơn: ví khách, các lần trừ tiền của đơn, dòng khóa của đơn, các khóa còn "đang xử lý". */
export interface World {
    wallet: number
    charges: Array<{ chargeId: string; amount: number }>
    key: { status: string; responseCode: number | null; fingerprint: string | null } | null
    processingKeys: number
}

export const world = async (order: OrderInput = ORDER): Promise<World> => {
    const [wallet] = await read<{ balance: string }>("payments", "SELECT balance FROM wallets WHERE customer_id = $1", [order.customerId])
    const charges = await read<{ id: string; amount: string }>("payments", "SELECT id, amount FROM charges WHERE order_id = $1 ORDER BY id", [
        order.orderId,
    ])
    const [own] = await read<{ payment_key: string }>("shop", "SELECT payment_key FROM orders WHERE id = $1", [order.orderId])
    const [key] =
        own === undefined
            ? []
            : await read<{ status: string; response_code: number | null; fingerprint: string | null }>(
                  "payments",
                  "SELECT status, response_code, fingerprint FROM idempotency_keys WHERE key = $1",
                  [own.payment_key],
              )
    const [processing] = await read<{ n: string }>("payments", "SELECT count(*) AS n FROM idempotency_keys WHERE status = 'processing'")
    return {
        wallet: Number(wallet?.balance ?? NaN),
        charges: charges.map((row) => ({ chargeId: `ch_${row.id}`, amount: Number(row.amount) })),
        key: key === undefined ? null : { status: key.status, responseCode: key.response_code, fingerprint: key.fingerprint },
        processingKeys: Number(processing?.n ?? 0),
    }
}

/** Ném lỗi `[invariant:<id>] <gợi ý>`: dòng hiện ra dưới một ca đỏ. */
export const holds = (condition: boolean, invariant: string, hint: string): void => {
    if (!condition) throw new Error(`[invariant:${invariant}] ${hint}`)
}

export const vnd = (amount: number): string => `${amount.toLocaleString("vi-VN")}đ`

export const show = (reply: { status: number; body: unknown }): string =>
    reply.status === 0 ? "không có câu trả lời" : `${reply.status} ${JSON.stringify(reply.body)}`

/** Mô tả ngắn các lần gửi trong nhật ký, để thông báo lỗi kể lại đúng chuyện đã xảy ra. */
export const story = (attempts: Array<Attempt>): string =>
    attempts
        .map((item) => `lần ${item.n}${item.kind === "send" ? "" : ` (${item.kind})`}: ${item.status === 0 ? "không có câu trả lời" : item.status}${item.delivered ? "" : " (rớt)"}`)
        .join("; ")

/**
 * Mỗi điều phải đúng của một ca là một bài kiểm thử riêng, tên mang hai nhãn `[case:<id>] [invariant:<id>]`: đọc
 * từ báo cáo JUnit ca nào đỏ và vì điều gì.
 */
export const check = (caseId: string, invariant: string, title: string, body: () => void): void => {
    test(`[case:${caseId}] [invariant:${invariant}] ${title}`, body)
}

/** Chuỗi trừ tiền của một đơn: đúng một lần trừ, ví giảm đúng số tiền. Dùng chung cho nhiều ca. */
export const checkChargedOnce = (caseId: string, seen: () => { now: World; start: number; order: OrderInput }): void => {
    check(caseId, "charged-once", "khách chỉ bị trừ tiền một lần cho lần thanh toán này", () => {
        const { now, start, order } = seen()
        holds(
            now.charges.length === 1 && now.wallet === start - order.amount,
            "charged-once",
            `sổ trừ tiền có ${now.charges.length} lần cho đơn ${order.orderId}, ví còn ${vnd(now.wallet)}; cần đúng 1 lần và ví còn ${vnd(start - order.amount)}`,
        )
    })
}
/** JSON với khoá xếp theo thứ tự: Postgres có thể đổi thứ tự khoá của câu trả lời đã lưu, nội dung thì vẫn y hệt. */
export const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (typeof value === "object" && value !== null)
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
            .join(",")}}`
    return JSON.stringify(value) ?? "undefined"
}

/** Hai thân câu trả lời có cùng nội dung không, bất kể thứ tự khoá. */
export const sameBody = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
