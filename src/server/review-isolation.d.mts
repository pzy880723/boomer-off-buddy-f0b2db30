type Env = Record<string, string | undefined>;
export declare const REVIEW_FLAG: "BOOMER_REVIEW_ISOLATED";
export declare const REVIEW_TOKEN_PREFIX: "rvw_";
export declare const REVIEW_ENVIRONMENT: "demo";
export declare const PRODUCTION_DATA_MARKERS: string[];
export declare const FORBIDDEN_CHANNEL_ENV: string[];
export declare const FORBIDDEN_TRUE_FLAGS: string[];
export declare const REQUIRED_ISOLATED_ENV: string[];
export declare function isReviewIsolated(env?: Env): boolean;
export declare function reviewIsolationViolations(env?: Env): string[];
export declare class ReviewIsolationError extends Error {
  readonly code: "review_isolation_violation";
  readonly violations: string[];
  constructor(violations: string[]);
}
export declare function assertReviewIsolation(env?: Env): void;
export declare function assertNoExternalWrite(channel: string, env?: Env): void;
export declare function genReviewDeviceToken(): string;
