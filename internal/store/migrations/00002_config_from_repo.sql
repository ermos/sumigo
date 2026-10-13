-- +goose Up
ALTER TABLE sites ADD COLUMN config_path TEXT NOT NULL DEFAULT 'config.yml';
ALTER TABLE sites DROP COLUMN collections;
ALTER TABLE sites DROP COLUMN media_folder;
ALTER TABLE sites DROP COLUMN public_folder;

-- +goose Down
ALTER TABLE sites ADD COLUMN collections TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sites ADD COLUMN media_folder TEXT NOT NULL DEFAULT '';
ALTER TABLE sites ADD COLUMN public_folder TEXT NOT NULL DEFAULT '';
ALTER TABLE sites DROP COLUMN config_path;
