// Disable the real SMTP mailer for e2e: registration must not depend on an
// external email provider. The mailer becomes a no-op, yet the verification
// token is still persisted to the DB, so email-verification flows stay
// testable. Runs before ConfigModule loads, so dotenv keeps this empty value
// instead of the .env key.
process.env.SMTP_HOST = '';
