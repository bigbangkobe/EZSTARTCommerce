export function paymentEnvironment(env = process.env) {
    return env['PAYMENTS_ENVIRONMENT'] === 'sandbox' ? 'sandbox' : 'production';
}
