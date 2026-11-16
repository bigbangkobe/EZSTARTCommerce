export type MarketReview = Readonly<{
  status: 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired';
  validUntil: Date | null;
}>;

/** Recheck on every quote/order; an approved label alone is insufficient. */
export function marketAllowsTrade(enabled: boolean, review: MarketReview, now: Date): boolean {
  return enabled && review.status === 'approved' && Number.isFinite(now.getTime()) &&
    (review.validUntil === null || review.validUntil.getTime() > now.getTime());
}
