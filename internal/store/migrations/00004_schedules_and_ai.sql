-- +goose Up
-- A scheduled publish merges an open draft pull request at publish_at.
CREATE TABLE schedules (
    site_id     INTEGER NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    pull_number INTEGER NOT NULL,
    publish_at  INTEGER NOT NULL,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (site_id, pull_number)
);

-- Instance-wide settings, encrypted like site tokens.
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value BLOB NOT NULL
);

ALTER TABLE sites ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE sites DROP COLUMN ai_enabled;
DROP TABLE settings;
DROP TABLE schedules;
