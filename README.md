# Thanh toán một lần với Idempotency-Key

Một shop gọi sang dịch vụ thanh toán để trừ tiền ví của khách. Mạng thì không bao giờ hoàn hảo: tiền vừa trừ xong mà câu trả
lời rớt trên đường về, shop không biết đã trừ hay chưa, nên gửi lại. Repo này là một cách làm chuẩn để khách chỉ bị trừ tiền
**một lần**, dù shop gửi lại bao nhiêu lần.

| Thư mục        | Ngôn ngữ                          | Trạng thái |
|----------------|-----------------------------------|------------|
| `/typescript`  | TypeScript, NestJS, Postgres      | có         |
| `/go`          | Go                                | sẽ có sau  |
| `/rust`        | Rust                              | sẽ có sau  |

Mỗi thư mục đứng riêng: tự có `package.json` (hoặc tương đương), `docker compose` và bộ kiểm thử. Không cần công cụ nào khác.

## Ý tưởng trong năm dòng

1. Bên gọi tạo **một khóa** cho mỗi lần thanh toán (một chuỗi ngẫu nhiên đủ dài) và gửi kèm trong header `Idempotency-Key`. Gửi
   lại thì giữ nguyên khóa đó.
2. Bên nhận **giành khóa trước** khi làm: chèn một dòng vào bảng khóa, primary key chỉ cho đúng một câu chèn cùng khóa được nhận.
3. Giành khóa, trừ tiền, ghi sổ và **lưu câu trả lời** nằm trong **một giao dịch**: sập giữa chừng thì như chưa chạy gì.
4. Gửi lại thì nhận lại **đúng câu trả lời đã lưu**, kể cả lời từ chối (402), với header `Idempotent-Replayed: true`. Cùng khóa mà
   nội dung khác thì bị từ chối (422 `KEY_REUSED`).
5. Khóa được giữ **24 giờ**, lâu hơn hẳn hạn chót gửi lại của bên gọi (2 phút); quá hạn thì quên, yêu cầu mang khóa đó là yêu cầu mới.

## Chạy thử (`/typescript`)

Cần Node 22 trở lên và Docker.

```bash
cd typescript
npm ci
npm test              # kiểm thử đơn vị: dấu của yêu cầu, cách gửi lại
npm run up            # dựng Postgres, shop (:4231) và payments (:4232)
npm run test:e2e      # tám tình huống, chạy trên hệ thống thật qua HTTP
npm run down
```

Cổng bận thì đặt `SHOP_PORT`, `PAYMENTS_PORT`, `PG_PORT` trước cả `npm run up` lẫn `npm run test:e2e`.

### Tám tình huống mà `test:e2e` kiểm

| Tình huống                                                           | Điều phải đúng                                                   |
|----------------------------------------------------------------------|------------------------------------------------------------------|
| Một lần thanh toán, mạng êm                                          | trả 201, trừ đúng một lần                                        |
| Hai đơn cùng lúc, hai khóa                                           | mỗi đơn nhận đúng câu trả lời của mình                           |
| Tiền trừ xong thì câu trả lời rớt, shop gửi lại                      | trừ một lần, lần gửi lại nhận đúng câu trả lời cũ                |
| Hai yêu cầu cùng khóa tới cách nhau 20 ms                            | trừ một lần, yêu cầu sau nhận câu trả lời cũ hoặc `IN_PROGRESS`  |
| Cùng khóa mà số tiền khác                                            | 422 `KEY_REUSED`, không trừ thêm                                 |
| Lần đầu bị từ chối vì ví không đủ, khách nạp thêm rồi gửi lại        | vẫn là lời từ chối cũ, không lén trừ tiền                        |
| Payments chết ngay sau khi trừ tiền                                  | bật lại, lần gửi lại xong đúng một lần, không khóa nào kẹt       |
| Đồng hồ chạy nhanh lên 23 giờ rồi 25 giờ                             | 23 giờ vẫn trả câu cũ, 25 giờ là yêu cầu mới, khóa cũ đã bị xoá  |

Các sự cố (mất câu trả lời, gửi trùng, cơ sở dữ liệu chập chờn, sập giữa chừng, tua đồng hồ) do bài kiểm thử bật qua
`PUT /lab/chaos`. Những đường này chỉ mở khi dịch vụ chạy với `TEST_HOOKS=on` (docker-compose.yml đặt sẵn); bản chạy thật để tắt.

## Đọc code từ đâu

- `typescript/src/platform/idempotency/idempotency.store.ts`: toàn bộ ý tưởng, trong một hàm `run`.
- `typescript/src/payments/payments.service.ts`: việc trừ tiền, chạy qua `run`.
- `typescript/src/shop/payments.client.ts` và `retry-policy.ts`: nửa bên gọi: một khóa cho mỗi lần thanh toán, chờ 1 giây, gửi lại
  tối đa 4 lần, mỗi lần chờ gấp đôi cộng một khoảng ngẫu nhiên, bỏ cuộc sau 2 phút.

## Hợp đồng HTTP

`POST /charges` (payments), header `Idempotency-Key`, thân `{ orderId, customerId, amount }`:

| Mã  | Thân                                            | Nghĩa                                             |
|-----|-------------------------------------------------|---------------------------------------------------|
| 201 | `{ chargeId, orderId, amount, status: "paid" }` | đã trừ tiền                                       |
| 402 | `{ error: "INSUFFICIENT_FUNDS" }`               | ví không đủ, không trừ gì                         |
| 409 | `{ error: "IN_PROGRESS" }`                      | yêu cầu cùng khóa đang chạy; gửi lại sau          |
| 422 | `{ error: "KEY_REUSED" }`                       | khóa này đã dùng cho một nội dung khác            |
| 503 | `{ error: "TRY_AGAIN" }`                        | lỗi tạm thời; gửi lại sau, cùng khóa              |

`POST /checkout` (shop), thân `{ orderId, customerId, amount }`: thanh toán một đơn; gọi lại cho cùng đơn là gửi lại cùng lần
thanh toán đó, với khóa cũ của đơn.

## Giấy phép

MIT.
