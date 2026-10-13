-- +goose Up
ALTER TABLE sites DROP COLUMN config_path;

-- +goose Down
ALTER TABLE sites ADD COLUMN config_path TEXT NOT NULL DEFAULT 'config.yml';
