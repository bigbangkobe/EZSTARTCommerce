/** Recheck on every quote/order; an approved label alone is insufficient. */
export function marketAllowsTrade(enabled, review, now) {
    return enabled && review.status === 'approved' && Number.isFinite(now.getTime()) &&
        (review.validUntil === null || review.validUntil.getTime() > now.getTime());
}
