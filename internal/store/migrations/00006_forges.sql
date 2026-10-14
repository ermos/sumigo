-- +goose Up
-- forge is github, gitlab or gitea (also Forgejo); forge_url the instance, empty for github.com and gitlab.com.
ALTER TABLE sites ADD COLUMN forge TEXT NOT NULL DEFAULT 'github';
ALTER TABLE sites ADD COLUMN forge_url TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE sites DROP COLUMN forge_url;
ALTER TABLE sites DROP COLUMN forge;
