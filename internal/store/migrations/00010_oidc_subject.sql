-- +goose Up
-- The provider identity ("issuer subject") a user logs in with: an email alone can be claimed at some providers.
ALTER TABLE users ADD COLUMN oidc_subject TEXT;
CREATE UNIQUE INDEX users_oidc_subject ON users (oidc_subject);

-- +goose Down
DROP INDEX users_oidc_subject;
ALTER TABLE users DROP COLUMN oidc_subject;
