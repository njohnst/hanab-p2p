/**
 * Analytics used to go to Google Analytics. This static, serverless fork does
 * not talk to any third-party service, so every export is a no-op kept with
 * its original signature to leave call sites untouched.
 */

export const initAnalytics: () => void = () => undefined;

export const logPageView: () => void = () => undefined;

export const logEvent: (category: string, action: string, options?: Record<string, unknown>) => void = () => undefined;
