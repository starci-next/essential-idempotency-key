import { DEFAULT_POLICY, backoffMs, isFinal } from "../../src/shop/retry-policy"

describe("the shop's resend policy", () => {
    it.each([
        [201, { chargeId: "ch_1" }],
        [402, { error: "INSUFFICIENT_FUNDS" }],
        [422, { error: "KEY_REUSED" }],
        [409, { error: "SOMETHING_ELSE" }],
    ])("treats %i as a final answer", (status, body) => {
        expect(isFinal(status, body)).toBe(true)
    })

    it.each([
        [0, null],
        [500, { error: "INTERNAL" }],
        [503, { error: "TRY_AGAIN" }],
        [409, { error: "IN_PROGRESS" }],
    ])("resends after %i", (status, body) => {
        expect(isFinal(status, body)).toBe(false)
    })

    it("doubles the pause each attempt and adds at most a quarter of the base as jitter", () => {
        expect([1, 2, 3].map((attempt) => backoffMs(DEFAULT_POLICY, attempt, () => 0))).toEqual([1_000, 2_000, 4_000])
        expect(backoffMs(DEFAULT_POLICY, 1, () => 0.999)).toBeLessThan(1_000 + 250)
    })

    it("gives up long before a key is forgotten", () => {
        expect(DEFAULT_POLICY.deadlineMs).toBeLessThan(24 * 60 * 60 * 1000)
    })
})
