import { canonicalJson, fingerprintOf } from "../../src/platform/idempotency/fingerprint"

describe("request fingerprint", () => {
    const charge = { method: "POST", path: "/charges", body: { orderId: "ord-001", customerId: "c-minh", amount: 1_200_000 } }

    it("is the same for the same request, whatever the key order of its body", () => {
        const reordered = { ...charge, body: { amount: 1_200_000, customerId: "c-minh", orderId: "ord-001" } }
        expect(fingerprintOf(reordered)).toBe(fingerprintOf(charge))
    })

    it("changes when the amount changes, so a reused key is caught", () => {
        expect(fingerprintOf({ ...charge, body: { ...charge.body, amount: 1_250_000 } })).not.toBe(fingerprintOf(charge))
    })

    it("changes with the path: the same body sent to another operation is another request", () => {
        expect(fingerprintOf({ ...charge, path: "/refunds" })).not.toBe(fingerprintOf(charge))
    })

    it("writes nested objects and arrays with sorted keys", () => {
        expect(canonicalJson({ b: [2, { d: 1, c: 0 }], a: null })).toBe('{"a":null,"b":[2,{"c":0,"d":1}]}')
    })
})
