-- +goose Up
-- Set with a temporary password: the user chooses their own at the next login.
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE users DROP COLUMN must_change_password;
